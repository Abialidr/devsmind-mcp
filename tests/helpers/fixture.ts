import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevMindDatabase, ReasoningObject } from '../../src/db/database';
import { StagedEntry, commitStagedChanges } from '../../src/db/staging';
import { DevMindConfig } from '../../src/utils/config';

export interface Fixture {
  /** Temp project root (parent of `.devmind`). */
  root: string;
  /** Absolute path to `<root>/.devmind`. */
  devmindPath: string;
  /** Absolute path to `<root>/src-repo`, the single configured repo ("app"). */
  repoDir: string;
  db: DevMindDatabase;
  cleanup: () => void;
}

export interface MakeFixtureOptions {
  /** Extra files to write into the repo, relative path -> content. Merged over the defaults. */
  extraFiles?: Record<string, string>;
  /** Skip writing the default foo.ts/bar.ts pair. */
  skipDefaultFiles?: boolean;
  /** Extra config.json fields to merge in (e.g. ignored_paths). */
  configOverrides?: Partial<DevMindConfig>;
  /** Write a .env with these key/value pairs (e.g. DEVELOPER_NAME). */
  env?: Record<string, string>;
}

/**
 * Builds a throwaway embedded-mode DevsMind brain: `.devmind/config.json` + a `src-repo/`
 * source tree + a live `DevMindDatabase`. Mirrors the minimal layout the CLI's `init` produces,
 * pared down to what `DevMindDatabase`'s constructor / `loadProjectContext` actually require.
 */
export function makeFixture(opts: MakeFixtureOptions = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-test-'));
  const devmindPath = path.join(root, '.devmind');
  const repoDir = path.join(root, 'src-repo');
  fs.mkdirSync(devmindPath, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  const config: DevMindConfig = {
    project_name: 'fixture',
    mode: 'embedded',
    repos: [{ name: 'app', relative_path: 'src-repo' }],
    ...opts.configOverrides
  };
  fs.writeFileSync(path.join(devmindPath, 'config.json'), JSON.stringify(config, null, 2));

  if (opts.env) {
    const envContent = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join('\n');
    fs.writeFileSync(path.join(devmindPath, '.env'), envContent);
  }

  if (!opts.skipDefaultFiles) {
    fs.writeFileSync(
      path.join(repoDir, 'foo.ts'),
      `import { format } from './bar';\n\nexport function greet(name: string): string {\n  return format(name);\n}\n`
    );
    fs.writeFileSync(
      path.join(repoDir, 'bar.ts'),
      `export function format(s: string): string {\n  return "hi " + s;\n}\n`
    );
  }

  for (const [relPath, content] of Object.entries(opts.extraFiles || {})) {
    const abs = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const db = new DevMindDatabase(path.join(devmindPath, 'brain.db'));

  return {
    root,
    devmindPath,
    repoDir,
    db,
    cleanup: () => {
      try { db.close(); } catch { /* already closed */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

/** Convenience: stage one or more entries and commit them in one call, returning the summary. */
export async function stageAndCommit(
  fixture: Pick<Fixture, 'db' | 'devmindPath'>,
  entries: StagedEntry[],
  reasoning: string | ReasoningObject = { what_changed: 'test change', why: 'test', goal: 'test fixture' }
) {
  return commitStagedChanges(fixture.db, fixture.devmindPath, entries, reasoning);
}

/** Absolute path to a file inside the fixture's repo. */
export function repoFile(fixture: Pick<Fixture, 'repoDir'>, relPath: string): string {
  return path.join(fixture.repoDir, relPath);
}

/** Default reasoning object satisfying the commit_changes gate shape used across tests. */
export function defaultReasoning(overrides: Partial<ReasoningObject> = {}): ReasoningObject {
  return {
    what_changed: 'test change',
    why: 'testing',
    goal: 'fixture verification',
    ...overrides
  };
}

/** Default feedback object satisfying the MCP commit_changes gate (all fields "none"). */
export function defaultFeedback() {
  return {
    graph_problems: 'none',
    edge_problems: 'none',
    tools_used: 'none',
    dropped_and_why: 'none',
    devsmind_better: 'none'
  };
}
