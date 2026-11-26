import { parentPort, workerData } from 'worker_threads';
import { gitSyncDevsmindBranch } from './devsmind-branch';

/**
 * Worker-thread entry for {@link runGitSyncOffThread}. The sync is built from synchronous git
 * calls, so run on the MCP server's own thread it would freeze the server for as long as it takes
 * — no status call could be answered while it ran. Here it blocks only this thread.
 */
const { devmindDir, message, opts } = workerData as {
  devmindDir: string;
  message: string;
  opts: { worktree?: string; resolved?: boolean };
};

try {
  parentPort!.postMessage({ ok: true, result: gitSyncDevsmindBranch(devmindDir, message, opts) });
} catch (err) {
  parentPort!.postMessage({ ok: false, error: (err as Error).message });
}
