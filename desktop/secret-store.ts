import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SafeStorage } from 'electron';

interface StoredSecret { ref: string; value: string; updatedAt: string; }

function validRef(value: unknown): value is string {
  return typeof value === 'string' && /^secret_[a-zA-Z0-9_-]{8,100}$/.test(value);
}

async function readStore(path: string): Promise<StoredSecret[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((v): v is StoredSecret => !!v && typeof v === 'object'
      && validRef((v as StoredSecret).ref) && typeof (v as StoredSecret).value === 'string') : [];
  } catch { return []; }
}

async function writeStore(path: string, values: StoredSecret[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(values)}\n`, 'utf8');
  await rename(temp, path);
}

export class CutaiSecretStore {
  private readonly path: string;
  private readonly safeStorage: SafeStorage;

  constructor(path: string, safeStorage: SafeStorage) {
    this.path = path;
    this.safeStorage = safeStorage;
  }

  async set(value: string, ref = `secret_${randomUUID().replace(/-/g, '')}`): Promise<string> {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable');
    if (!value || !validRef(ref)) throw new Error('Invalid secret input');
    const values = (await readStore(this.path)).filter((entry) => entry.ref !== ref);
    values.push({ ref, value: this.safeStorage.encryptString(value).toString('base64'), updatedAt: new Date().toISOString() });
    await writeStore(this.path, values);
    return ref;
  }

  async has(ref: string): Promise<boolean> { return validRef(ref) && (await readStore(this.path)).some((entry) => entry.ref === ref); }
  async delete(ref: string): Promise<void> { if (validRef(ref)) await writeStore(this.path, (await readStore(this.path)).filter((entry) => entry.ref !== ref)); }
  async getForMainProcess(ref: string): Promise<string | null> {
    if (!validRef(ref) || !this.safeStorage.isEncryptionAvailable()) return null;
    const entry = (await readStore(this.path)).find((value) => value.ref === ref);
    return entry ? this.safeStorage.decryptString(Buffer.from(entry.value, 'base64')) : null;
  }
}
