import type { FramePixels, SemanticDevice, WorkerRequest, WorkerResponse } from './types';

type ProgressListener = (progress?: number, file?: string) => void;
type PendingRequest = {
  resolve: (vector?: number[]) => void;
  reject: (reason?: unknown) => void;
  onProgress?: ProgressListener;
};

export class SemanticClient {
  private worker: Worker | null = null;
  private requestId = 0;
  private runtimeKey = '';
  private runtimeDevice: SemanticDevice | null = null;
  private runtimeCpuThreads = 1;
  private onRuntimeDevice?: (device: SemanticDevice) => void;
  private fallbackLoad: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();

  load(
    device: SemanticDevice,
    cpuThreads: number,
    onProgress?: ProgressListener,
    onRuntimeDevice?: (device: SemanticDevice) => void,
  ): Promise<void> {
    const runtimeKey = `${device}:${Math.max(1, Math.round(cpuThreads) || 1)}`;
    if (this.runtimeKey && this.runtimeKey !== runtimeKey) this.cancel();
    this.runtimeKey = runtimeKey;
    this.runtimeDevice = device;
    this.runtimeCpuThreads = Math.max(1, Math.round(cpuThreads) || 1);
    this.onRuntimeDevice = onRuntimeDevice;
    onRuntimeDevice?.(device);
    return this.request({ id: this.nextId(), type: 'load', device, cpuThreads }, onProgress).then(() => undefined);
  }

  async embedText(text: string): Promise<number[]> {
    try {
      return await this.request({ id: this.nextId(), type: 'embed-text', text }).then(requireVector);
    } catch (reason) {
      await this.recoverWebGpuInference(reason);
      return this.request({ id: this.nextId(), type: 'embed-text', text }).then(requireVector);
    }
  }

  async embedImage(frame: FramePixels): Promise<number[]> {
    // WebGPU can load successfully and still fail on the first unsupported
    // operator. Preserve one copy because the first transfer detaches data.
    const retryFrame = this.runtimeDevice === 'webgpu'
      ? { ...frame, data: frame.data.slice() }
      : null;
    try {
      const request: WorkerRequest = { id: this.nextId(), type: 'embed-image', frame };
      return await this.request(request, undefined, [frame.data.buffer as ArrayBuffer]).then(requireVector);
    } catch (reason) {
      await this.recoverWebGpuInference(reason);
      if (!retryFrame) throw reason;
      const request: WorkerRequest = { id: this.nextId(), type: 'embed-image', frame: retryFrame };
      return this.request(request, undefined, [retryFrame.data.buffer as ArrayBuffer]).then(requireVector);
    }
  }

  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    const error = new DOMException('Semantic indexing canceled', 'AbortError');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.runtimeKey = '';
    this.runtimeDevice = null;
    this.onRuntimeDevice = undefined;
  }

  private async recoverWebGpuInference(reason: unknown): Promise<void> {
    if (reason instanceof DOMException && reason.name === 'AbortError') throw reason;
    if (this.runtimeDevice !== 'webgpu') throw reason;
    if (!this.fallbackLoad) {
      const cpuThreads = this.runtimeCpuThreads;
      const onRuntimeDevice = this.onRuntimeDevice;
      this.cancel();
      this.fallbackLoad = this.load('wasm', cpuThreads, undefined, onRuntimeDevice)
        .finally(() => { this.fallbackLoad = null; });
    }
    await this.fallbackLoad;
  }

  private nextId(): number {
    this.requestId += 1;
    return this.requestId;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.failAll(new Error(event.message || 'Semantic worker failed'));
    return this.worker;
  }

  private request(request: WorkerRequest, onProgress?: ProgressListener, transfer?: Transferable[]): Promise<number[] | undefined> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject, onProgress });
      this.getWorker().postMessage(request, transfer ?? []);
    });
  }

  private handleMessage(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (response.type === 'progress') {
      pending.onProgress?.(response.progress, response.file);
      return;
    }
    this.pending.delete(response.id);
    if (response.type === 'error') pending.reject(new Error(response.message));
    else pending.resolve(response.vector);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

function requireVector(vector?: number[]): number[] {
  if (!vector) throw new Error('Semantic model returned no embedding');
  return vector;
}
