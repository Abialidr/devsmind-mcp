import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { acquireSyncLock, readSyncLock, syncLockPath, SYNC_LOCK_STALE_MS } from '../../src/utils/sync-lock';

describe('sync-lock — one git sync per brain at a time', () => {
  let devDir: string;

  beforeEach(() => {
    devDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-lock-test-'));
  });

  afterEach(() => {
    fs.rmSync(devDir, { recursive: true, force: true });
  });

  function writeLock(holder: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(syncLockPath(devDir)), { recursive: true });
    fs.writeFileSync(syncLockPath(devDir), JSON.stringify(holder));
  }

  it('a second attempt is refused while the first holds the lock, and succeeds once it is released', () => {
    const first = acquireSyncLock(devDir, 'job-1');
    expect(first.acquired).toBe(true);

    const second = acquireSyncLock(devDir, 'job-2');
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.holder?.pid).toBe(process.pid);
      expect(second.holder?.jobId).toBe('job-1');
    }

    if (first.acquired) first.release();
    expect(fs.existsSync(syncLockPath(devDir))).toBe(false);
    const third = acquireSyncLock(devDir);
    expect(third.acquired).toBe(true);
    if (third.acquired) third.release();
  });

  it('takes over a lock whose process is gone, so a crashed sync cannot block syncing forever', () => {
    // A pid far above any real one on this machine — its process cannot exist.
    writeLock({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: new Date().toISOString() });
    expect(readSyncLock(devDir)).toBeNull();

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const attempt = acquireSyncLock(devDir);
      expect(attempt.acquired).toBe(true);
      if (attempt.acquired) attempt.release();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('takes over a lock older than the stale limit even when its pid looks alive (pids get reused)', () => {
    writeLock({ pid: process.pid, host: os.hostname(), startedAt: new Date(Date.now() - SYNC_LOCK_STALE_MS - 1000).toISOString() });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(acquireSyncLock(devDir).acquired).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('never steals a live lock from another host — it cannot check that pid', () => {
    writeLock({ pid: 2 ** 22 + 12345, host: 'some-other-machine', startedAt: new Date().toISOString() });
    expect(acquireSyncLock(devDir).acquired).toBe(false);
    expect(readSyncLock(devDir)?.host).toBe('some-other-machine');
  });

  it('release never removes a lock that a later sync has taken over', () => {
    const first = acquireSyncLock(devDir, 'job-1');
    expect(first.acquired).toBe(true);
    // Someone else's lock now sits in the file (e.g. ours was judged abandoned and replaced).
    writeLock({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), jobId: 'job-2' });
    if (first.acquired) first.release();
    expect(readSyncLock(devDir)?.jobId).toBe('job-2');
  });
});
