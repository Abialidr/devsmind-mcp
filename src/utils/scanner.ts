import * as fs from 'fs';
import * as path from 'path';
import { DevMindConfig, loadProjectContext, resolveRepoPath } from './config';

/**
 * Extensions we consider indexable source files. Also the source of truth for
 * what `stage_change` will accept — DevsMind models functions/classes/logic
 * entities, not stylesheets, markup, config, or other non-code assets, so
 * anything outside this set is out of scope by design, not an oversight.
 */
export const INDEXABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.cs', '.rb', '.php',
  '.rs', '.swift', '.kt', '.dart', '.vue', '.svelte'
]);

/** Default patterns always ignored regardless of config */
const ALWAYS_IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '__pycache__', '.venv', 'venv', 'coverage', '.turbo',
  '.cache', '.idea', '.vscode'
];

function shouldIgnore(filePath: string, ignoredPaths: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const allIgnored = [...ALWAYS_IGNORED, ...ignoredPaths];
  return allIgnored.some(pattern => {
    const p = pattern.replace(/\\/g, '/').replace(/\/$/, '');
    return normalized.includes(`/${p}/`) || normalized.includes(`/${p}`) || normalized.endsWith(`/${p}`);
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
