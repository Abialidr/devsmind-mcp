import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { gitSyncDevsmindBranch, GitSyncResult } from './devsmind-branch';

/**
 * Runs {@link gitSyncDevsmindBranch} on a worker thread and resolves with its result.
 *
 * Only the built package has a compiled worker file to start. Running from TypeScript sources
 * (tests, `tsx`) there is none, so the sync runs on this thread after one tick instead — the
 * result is identical, the server simply cannot answer other calls while it runs.
 */
export function runGitSyncOffThread(
  devmindDir: string,
  message: string,
  opts: { worktree?: string; resolved?: boolean } = {}
): Promise<GitSyncResult> {
  const workerFile = path.join(__dirname, 'git-sync-worker.js');
  if (!__filename.endsWith('.js') || !fs.existsSync(workerFile)) {
    return new Promise((resolve, reject) => setImmediate(() => {
      try {
        resolve(gitSyncDevsmindBranch(devmindDir, message, opts));
      } catch (err) {
        reject(err);
      }
    }));
  }

  return new Promise((resolve, reject) => {
    // stdout: true captures the worker's stdout instead of sharing ours. In stdio mode our stdout
    // IS the MCP protocol stream, and a stray console.log from the worker would corrupt it.
    const worker = new Worker(workerFile, { workerData: { devmindDir, message, opts }, stdout: true });
    worker.stdout.pipe(process.stderr);
    let settled = false;
    worker.once('message', (msg: { ok: boolean; result?: GitSyncResult; error?: string }) => {
      settled = true;
      if (msg.ok) resolve(msg.result!);
      else reject(new Error(msg.error));
    });
    worker.once('error', err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', code => {
      if (settled) return;
      settled = true;
      reject(new Error(`devsmind git-sync: the sync worker exited unexpectedly (code ${code}).`));
    });
  });
}
