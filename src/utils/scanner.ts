import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig, loadProjectContext, resolveRepoPath } from './config';

/**
 * Extensions we consider indexable source files — this is the FILE-SCAN set (what `walkDir`
 * even looks at), broader than what can actually be parsed into graph nodes: `edit_node` and the
 * in-chat indexing tools only trace structure from `AST_PARSEABLE_EXTENSIONS` (see ast.ts) —
 * currently TS/JS. Everything else here still gets a whole-file activity-log entry on edit, just
 * no graph node. Stylesheets, markup, config, and other non-code assets are outside this set
 * entirely, by design, not an oversight.
 */
export const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.cs', '.rb', '.php',
  '.rs', '.swift', '.kt', '.dart', '.vue', '.svelte'
]);

/** Default patterns always ignored regardless of config. Mirrors grep.ts's ALWAYS_IGNORED. */
const ALWAYS_IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '__pycache__', '.venv', 'venv', 'coverage', '.turbo',
  '.cache', '.idea', '.vscode', '.devmind',
  '.dart_tool', '.gradle', '.symlinks', 'Pods', 'DerivedData', '.expo', 'Carthage'
];

function shouldIgnore(filePath: string, ignoredPaths: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const allIgnored = [...ALWAYS_IGNORED, ...ignoredPaths];
  return allIgnored.some(pattern => {
    // Strip a LEADING slash as well as a trailing one: `.gitignore` writes a repo-root anchor as
    // `/dist`, and that form survives import (it has no glob metacharacter), so it lands here
    // verbatim. Without this the test became `.includes('//dist/')` — a doubled slash no real
    // path contains — and the entry matched nothing at all, silently. Mirrors grep.ts.
    const p = pattern.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
    // Match on full path-segment boundaries only — a plain `.includes(`/${p}`)` (no trailing
    // boundary) would treat `p` as a prefix, e.g. ignoring "out" would also swallow an unrelated
    // "outbound-service" directory since "/outbound".includes("/out") is true.
    return normalized.includes(`/${p}/`) || normalized.endsWith(`/${p}`);
  });
}

function walkDir(dir: string, ignoredPaths: string[], results: string[] = []): string[] {
  if (!fs.existsSync(dir)) return results;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (shouldIgnore(fullPath, ignoredPaths)) continue;

    if (entry.isDirectory()) {
      walkDir(fullPath, ignoredPaths, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (INDEXABLE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

export interface RepoFileList {
  repo_name: string;
  repo_path: string;
  files: string[];
  file_count: number;
}

/**
 * Scans all configured repos and returns indexable files per repo.
 */
export function scanRepoFiles(devmindPath: string): {
  repos: RepoFileList[];
  total_files: number;
} {
  const context = loadProjectContext(devmindPath);
  const { config } = context;
  const ignoredPaths: string[] = config.ignored_paths ?? [];

  const repos: RepoFileList[] = [];

  for (const repo of config.repos) {
    const repoPath = resolveRepoPath(context, repo.name);
    if (!repoPath) {
      repos.push({ repo_name: repo.name, repo_path: '(path not configured)', files: [], file_count: 0 });
      continue;
    }
    const files = walkDir(repoPath, ignoredPaths);
    repos.push({ repo_name: repo.name, repo_path: repoPath, files, file_count: files.length });
  }

  const total_files = repos.reduce((sum, r) => sum + r.file_count, 0);
  return { repos, total_files };
}
