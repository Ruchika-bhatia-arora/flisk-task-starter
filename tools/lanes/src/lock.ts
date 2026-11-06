import { closeSync, mkdirSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const STALE_MS = 60_000;
const RETRY_MS = 25;

const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `work` while holding `lockPath`: serialised inside this process, and across processes by creating the lock
 * file exclusively (O_EXCL). Two `lanes create` runs (CLI and dashboard) can then never pick the same slot.
 * A lock older than a minute is treated as left behind by a crashed run and taken over.
 */
export function withLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => holdFileLock(lockPath, work));
  queues.set(lockPath, next);
  return next;
}

async function holdFileLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (isStale(lockPath)) rmSync(lockPath, { force: true });
      else await Bun.sleep(RETRY_MS);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function isStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}
