export type ReleaseTaskPermit = () => void;

interface WaitingTask {
  resolve: (release: ReleaseTaskPermit) => void;
}

/** FIFO limiter for expensive local work such as Remotion exports. */
export class TaskLimiter {
  private active = 0;
  private readonly waiting: WaitingTask[] = [];

  private limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('task limiter limit must be a positive integer');
    }
    this.limit = limit;
  }

  /** Apply a live settings change. Lower limits affect future starts; raising
   * the limit immediately drains as many queued tasks as the new budget allows. */
  setLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('task limiter limit must be a positive integer');
    }
    this.limit = limit;
    this.drain();
  }

  acquire(): Promise<ReleaseTaskPermit> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => this.waiting.push({ resolve }));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  snapshot(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.waiting.length, limit: this.limit };
  }

  private releaseOnce(): ReleaseTaskPermit {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.waiting.shift();
      if (!next) return;
      this.active += 1;
      next.resolve(this.releaseOnce());
    }
  }
}
