import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

export interface StandaloneRepoConfig {
  name: string;
  path_key: string;
  relative_path?: never;
}

export interface EmbeddedRepoConfig {
  name: string;
  relative_path: string;
  path_key?: never;
}

export type RepoConfig = StandaloneRepoConfig | EmbeddedRepoConfig;

export interface TechStack {
  languages?: string[];
  frameworks?: string[];
}

export interface DevMindConfig {
  project_name: string;
  mode: 'embedded' | 'standalone';
  notes?: string;
  session_timeout_minutes?: number;
  ignored_paths?: string[];
  tech_stack?: TechStack;
  environments?: Record<string, string>;
  repos: RepoConfig[];
}

export interface Developer {
  name: string;
  email: string;
}

export interface ProjectContext {
  devmind_path: string;
  config: DevMindConfig;
  env: Record<string, string>;
  developer?: Developer;
}

/**
 * Walk up from `startDir` looking for a `.devmind/config.json`. Returns the
 * absolute path to the `.devmind` directory, or null if none is found.
 */
export function findDevmindDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, '.devmind');
    if (fs.existsSync(path.join(candidate, 'config.json'))) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the `.devmind` directory for a command: honour an explicit `--path`
 * (which must itself contain a config.json), otherwise auto-detect by walking
 * up from the current working directory. Returns null when nothing is found.
 */
export function resolveDevmindDir(explicitPath?: string): string | null {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    return fs.existsSync(path.join(resolved, 'config.json')) ? resolved : null;
  }
  return findDevmindDir(process.cwd());
}

/**
 * Loads project config.json and .env from the given .devmind directory path.
 */
export function loadProjectContext(devmindPath: string): ProjectContext {
  const resolvedPath = path.resolve(devmindPath);
  const configPath = path.join(resolvedPath, 'config.json');
  const envPath = path.join(resolvedPath, '.env');

  if (!fs.existsSync(configPath)) {
    throw new Error(`DevMind config.json not found at ${configPath}. Run 'devsmind init' first.`);
  }

  // Load config.json
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(configContent) as DevMindConfig;

  // Load .env if it exists
  const env: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const parsedEnv = dotenv.parse(envContent);
    Object.assign(env, parsedEnv);
  }

  // Extract developer info from .env if present
  const developer: Developer | undefined = env['DEVELOPER_NAME']
    ? { name: env['DEVELOPER_NAME'], email: env['DEVELOPER_EMAIL'] || '' }
    : undefined;

  return { devmind_path: resolvedPath, config, env, developer };
}

/**
 * Resolve absolute repo path based on mode.
 */
export function resolveRepoPath(context: ProjectContext, repoName: string): string | null {
  const repo = context.config.repos.find(r => r.name === repoName);
  if (!repo) return null;

  if (context.config.mode === 'embedded') {
    // In embedded mode, paths are relative to the parent of the .devmind folder (i.e. the project root)
    if ('relative_path' in repo && repo.relative_path) {
      const projectRoot = path.dirname(context.devmind_path);
      return path.resolve(projectRoot, repo.relative_path);
    }
    return null;
  } else {
    // In standalone mode, look up in environment variables using path_key
    if ('path_key' in repo && repo.path_key) {
      const localPath = context.env[repo.path_key];
      return localPath ? path.resolve(localPath) : null;
    }
    return null;
  }
}
