import * as fs from 'fs';
import * as path from 'path';
import { resolveDevmindDir, loadProjectContext, isStandaloneMode, StandaloneRepoConfig } from '../utils/config';
import { browseForDir, textPrompt, CancelledError } from './integrations/prompt';
import { runBackgroundIndexing } from './runner';
import { readScratchpad } from '../db/indexer';

/** `IndexScratchpad`'s own progress file for this repo's indexing run — kept resumable via
 *  `runBackgroundIndexing`'s `padFile` override (see runner.ts). Dedicated to `add-repo` alone,
 *  so resuming it can never collide with (or accidentally resume) an unrelated `--repos` run. */
const ADD_REPO_INDEX_SCRATCHPAD = 'add_repo_scratchpad.json';

/**
 * A tiny marker recording WHICH repo an interrupted `add-repo` run was for — separate from the
 * indexing scratchpad above, because `config.json`/`.env` are written BEFORE indexing starts, so
 * a crash in that narrow window (before the indexer has touched a single file, when
 * `IndexScratchpad.current_repo` is still null) would otherwise leave nothing to resume from.
 * Deleted once indexing actually reaches `status: 'complete'`.
 */
const ADD_REPO_PENDING_FILE = 'add_repo_pending.json';

interface AddRepoPending {
  repo_name: string;
}

function pendingPath(devmindDir: string): string {
  return path.join(devmindDir, ADD_REPO_PENDING_FILE);
}

function readPending(devmindDir: string): AddRepoPending | null {
  const p = pendingPath(devmindDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as AddRepoPending;
  } catch {
    return null;
  }
}

/**
 * `devsmind add-repo` — adds ONE repo to an existing STANDALONE brain (prompting for its name
 * and local path, same as `devsmind init`'s existing-brain path-repair step) and indexes just
 * that repo, reusing `index --run`'s own machinery via `runBackgroundIndexing({ repos: [name] })`.
 *
 * Resumable: if a previous run was interrupted mid-index, re-running this command detects the
 * pending marker and continues that repo's indexing directly — no name/path prompt again.
 */
export async function handleAddRepo(opts: {
  path?: string;
  provider?: string;
  model?: string;
  key?: string;
  url?: string;
  chunkSize?: string;
  chunkOverlap?: string;
  describeBatchSize?: string;
  rpm?: string;
  yes?: boolean;
}): Promise<void> {
  const devmindDir = resolveDevmindDir(opts.path);
  if (!devmindDir) {
    console.error(
      `❌ No .devsmind directory found (nor a legacy .devmind one).\n` +
      `   Run from inside a DevsMind brain folder, or pass --path <devmind_path>.`
    );
    process.exit(1);
  }

  const ctx = loadProjectContext(devmindDir);
  if (!isStandaloneMode(ctx.config)) {
    console.error(
      `❌ devsmind add-repo is only available in standalone mode.\n` +
      `   An embedded brain already covers exactly the one repo it lives inside — there's nothing to add.`
    );
    process.exit(1);
  }

  const indexOpts = {
    devmindPath: devmindDir,
    provider: (opts.provider as 'gemini' | 'vertex' | 'ollama') ?? 'gemini',
    model: opts.model,
    key: opts.key,
    url: opts.url,
    chunkSize: opts.chunkSize ? parseInt(opts.chunkSize, 10) : undefined,
    chunkOverlap: opts.chunkOverlap ? parseInt(opts.chunkOverlap, 10) : undefined,
    describeBatchSize: opts.describeBatchSize ? parseInt(opts.describeBatchSize, 10) : undefined,
    rpm: opts.rpm ? parseInt(opts.rpm, 10) : undefined,
    yes: !!opts.yes,
    padFile: ADD_REPO_INDEX_SCRATCHPAD
  };

  const pending = readPending(devmindDir);
  let repoName: string;

  if (pending) {
    repoName = pending.repo_name;
    console.log(`\n🔁 DevsMind — Resuming add-repo for "${repoName}"`);
  } else {
    console.log(`\n➕ DevsMind — Add a repo to this brain`);

    try {
      repoName = await textPrompt('Repository name?', {
        validate: v => {
          const trimmed = v.trim();
          if (!trimmed) return 'A name is required.';
          if (ctx.config.repos.some(r => r.name === trimmed)) return `A repo named "${trimmed}" already exists in this brain.`;
          return true;
        }
      });
    } catch (err) {
      if (err instanceof CancelledError) { console.log('\nCancelled.'); return; }
      throw err;
    }

    const localPath = await browseForDir(`Select the local folder for repository "${repoName}"`, process.cwd());
    if (localPath === null) { console.log('\nCancelled.'); return; }

    const pathKey = `REPO_${repoName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const newRepo: StandaloneRepoConfig = { name: repoName, path_key: pathKey };

    const configPath = path.join(devmindDir, 'config.json');
    ctx.config.repos.push(newRepo);
    fs.writeFileSync(configPath, JSON.stringify(ctx.config, null, 2) + '\n', 'utf-8');
    console.log(`\n💾 Added "${repoName}" to ${configPath.replace(/\\/g, '/')}`);

    const envPath = path.join(devmindDir, '.env');
    const envLines = fs.existsSync(envPath)
      ? fs.readFileSync(envPath, 'utf-8').split('\n').filter(l => l.trim())
      : [];
    envLines.push(`${pathKey}=${localPath}`);
    fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf-8');
    console.log(`💾 Updated ${envPath.replace(/\\/g, '/')}`);

    fs.writeFileSync(pendingPath(devmindDir), JSON.stringify({ repo_name: repoName } as AddRepoPending, null, 2), 'utf-8');
  }

  console.log(`\n🧠 Indexing "${repoName}"...`);
  try {
    await runBackgroundIndexing({ ...indexOpts, repos: [repoName] });
  } catch (err) {
    console.error(`\n⚠️  Indexing stopped: ${(err as Error).message}`);
    console.error(`   Re-run "devsmind add-repo" to continue — it will resume "${repoName}" automatically.`);
    return;
  }

  const pad = readScratchpad(devmindDir, ADD_REPO_INDEX_SCRATCHPAD);
  if (pad && pad.status === 'complete') {
    try { fs.unlinkSync(pendingPath(devmindDir)); } catch { /* best-effort */ }
    console.log(`\n✅ "${repoName}" added and indexed.`);
  } else {
    console.log(`\nℹ️  Indexing for "${repoName}" is not finished yet. Re-run "devsmind add-repo" to continue.`);
  }
}
