import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import prompts from 'prompts';
import * as dotenv from 'dotenv';
import { DevMindDatabase } from '../db/database';
import {
  DevMindConfig,
  RepoConfig,
  EmbeddedRepoConfig,
  StandaloneRepoConfig,
  TechStack
} from '../utils/config';

// ─── Detection Helpers ─────────────────────────────────────────────────────

/** Read a global git config value (user.name, user.email, etc.) */
function readGitConfig(key: string): string {
  try {
    return execSync(`git config ${key}`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

/** Parse non-comment, non-empty lines from a .gitignore file */
function readGitIgnorePatterns(dir: string): string[] {
  const gitignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return [];
  return fs.readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l && !l.startsWith('#'));
}

/** Detect tech stack from package.json and project indicator files */
function detectTechStack(repoPaths: string[]): TechStack {
  const frameworks = new Set<string>();
  const languages = new Set<string>();

  for (const repoPath of repoPaths) {
    if (!fs.existsSync(repoPath)) continue;

    // Language detection from indicator files
    if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) languages.add('typescript');
    if (fs.existsSync(path.join(repoPath, 'go.mod'))) languages.add('go');
    if (fs.existsSync(path.join(repoPath, 'pom.xml'))) languages.add('java');
    if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) languages.add('rust');
    if (
      fs.existsSync(path.join(repoPath, 'requirements.txt')) ||
      fs.existsSync(path.join(repoPath, 'pyproject.toml'))
    ) languages.add('python');

    // Framework + language detection from package.json
    const pkgPath = path.join(repoPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      if (!languages.has('typescript')) languages.add('javascript');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['@nestjs/core']) frameworks.add('nestjs');
        if (deps['express']) frameworks.add('express');
        if (deps['next']) frameworks.add('nextjs');
        if (deps['react'] && !deps['next']) frameworks.add('react');
        if (deps['vue']) frameworks.add('vue');
        if (deps['fastify']) frameworks.add('fastify');
        if (deps['@angular/core']) frameworks.add('angular');
        if (deps['svelte']) frameworks.add('svelte');
        if (deps['hono']) frameworks.add('hono');
        if (deps['koa']) frameworks.add('koa');
        if (deps['prisma'] || deps['@prisma/client']) frameworks.add('prisma');
        if (deps['typeorm']) frameworks.add('typeorm');
        if (deps['mongoose']) frameworks.add('mongoose');
      } catch { /* skip malformed package.json */ }
    }
  }

  return {
    languages: [...languages],
    frameworks: [...frameworks]
  };
}

/** Aggregate unique ignored patterns from multiple repo paths */
function aggregateIgnoredPaths(repoPaths: string[]): string[] {
  const all = repoPaths.flatMap(p => readGitIgnorePatterns(p));
  return [...new Set(all)];
}

function ensureDbInitialized(dbPath: string) {
  const db = new DevMindDatabase(dbPath);
  db.close();
}

function scanSubdirectories(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

interface TreeEntry {
  name: string;
  fullPath: string;
  relativePath: string;
  isDir: boolean;
}

function buildFileTree(dir: string, repoRoot: string): TreeEntry[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter(entry => {
        const name = entry.name;
        // Skip default ignored folders
        if (name === '.git' || name === '.devmind' || name === 'node_modules') {
          return false;
        }
        return true;
      })
      .map(entry => {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
        return {
          name: entry.name,
          fullPath,
          relativePath,
          isDir: entry.isDirectory()
        };
      })
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

async function showIgnorePresets(excludedPaths: Set<string>, repoRoot: string) {
  // Step A: Offer to use detected .gitignore patterns
  const detectedPatterns = readGitIgnorePatterns(repoRoot);
  if (detectedPatterns.length > 0) {
    const preview = detectedPatterns.slice(0, 5).join(', ') + (detectedPatterns.length > 5 ? `, ... (+${detectedPatterns.length - 5} more)` : '');
    const gitResponse = await prompts({
      type: 'confirm',
      name: 'useGitignore',
      message: `Auto-ignore patterns from .gitignore? (${preview})`,
      initial: true
    });
    if (gitResponse.useGitignore) {
      for (const p of detectedPatterns) excludedPaths.add(p);
    }
  }

  // Step B: Offer to add common non-code preset ignores
  const response = await prompts({
    type: 'confirm',
    name: 'usePresets',
    message: 'Also auto-ignore common config/non-code files? (lockfiles, tsconfig, eslint configs, etc.)',
    initial: true
  });

  if (response.usePresets) {
    const commonIgnores = [
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'jest.config.js',
      'jest.config.ts',
      'webpack.config.js',
      'next.config.js',
      'next.config.mjs',
      '.eslintrc.json',
      '.eslintrc.js',
      '.eslintrc',
      '.prettierrc'
    ];
    for (const file of commonIgnores) {
      if (fs.existsSync(path.join(repoRoot, file))) {
        excludedPaths.add(file);
      }
    }
  }
}

async function runFileBrowser(repoRoot: string, excludedPaths: Set<string>): Promise<void> {
  let currentDir = repoRoot;
  let browsing = true;
  let lastSelectedIndex = 0; // Remember cursor position across iterations

  while (browsing) {
    const relDir = path.relative(repoRoot, currentDir).replace(/\\/g, '/');
    const displayDir = relDir === '' ? './ (Root)' : `./${relDir}`;

    console.log(`\n📂 Current Folder: ${displayDir}`);

    const activeExclusions = Array.from(excludedPaths);
    const isParentExcluded = activeExclusions.some(p => {
      const cleanPattern = p.replace(/\/$/, '');
      const cleanRelDir = relDir.replace(/\/$/, '');
      return cleanRelDir === cleanPattern || cleanRelDir.startsWith(cleanPattern + '/');
    });

    if (isParentExcluded) {
      console.log('⚠️  Note: This folder is inside an EXCLUDED directory. Contents will be ignored.');
    }

    const entries = buildFileTree(currentDir, repoRoot);
    if (entries.length === 0) {
      console.log('   (Empty directory)');
    }

    const choices = [];
    choices.push({ title: '✨ [Finish & Save Exclusions]', value: { action: 'done' } });
    if (currentDir !== repoRoot) {
      choices.push({ title: '⬆  Go Up (..)', value: { action: 'up' } });
    }

    for (const entry of entries) {
      // Check if this entry or any of its ancestor paths are excluded
      const cleanEntryPath = entry.relativePath.replace(/\/$/, '');
      let isExcluded = false;
      let isInheritedExcluded = false;

      for (const pattern of excludedPaths) {
        const cleanPattern = pattern.replace(/\/$/, '');
        if (cleanEntryPath === cleanPattern) {
          isExcluded = true;
          break;
        }
        if (cleanEntryPath.startsWith(cleanPattern + '/')) {
          isInheritedExcluded = true;
        }
      }

      let statusText: string;
      if (isExcluded) {
        statusText = '🚫 [EXCLUDED]';
      } else if (isInheritedExcluded) {
        statusText = '🚫 [EXCLUDED via parent]';
      } else {
        statusText = '✅ [INCLUDED]';
      }
      if (entry.isDir) {
        choices.push({
          title: `${statusText} Folder: ${entry.name}/`,
          value: { action: 'toggle', entry }
        });
        choices.push({
          title: `   └─ 🔍 Browse ${entry.name}/ →`,
          value: { action: 'browse', entry }
        });
      } else {
        choices.push({
          title: `${statusText} File: ${entry.name}`,
          value: { action: 'toggle', entry }
        });
      }
    }

    const response = await prompts({
      type: 'select',
      name: 'result',
      message: 'Select an entry to toggle or browse:',
      choices,
      initial: Math.min(lastSelectedIndex, choices.length - 1)
    });

    // Record the index of the selected choice so we can restore it next iteration
    if (response.result !== undefined) {
      const selectedIdx = choices.findIndex(
        c => JSON.stringify(c.value) === JSON.stringify(response.result)
      );
      if (selectedIdx !== -1) lastSelectedIndex = selectedIdx;
    }

    if (response.result === undefined) {
      console.log('⚠️  Selection cancelled. Keeping current exclusions.');
      browsing = false;
      break;
    }

    const { action, entry } = response.result;

    if (action === 'done') {
      browsing = false;
    } else if (action === 'up') {
      // Safety: never navigate above the repo root
      const parent = path.dirname(currentDir);
      currentDir = parent.startsWith(repoRoot) ? parent : repoRoot;
      lastSelectedIndex = 0; // Reset cursor when changing directory
    } else if (action === 'browse') {
      currentDir = entry.fullPath;
      lastSelectedIndex = 0; // Reset cursor when entering a subdirectory
    } else if (action === 'toggle') {
      const cleanPath = entry.relativePath.replace(/\/$/, '');
      let found = false;
      for (const pattern of excludedPaths) {
        if (pattern.replace(/\/$/, '') === cleanPath) {
          excludedPaths.delete(pattern);
          found = true;
        }
      }
      if (!found) {
        excludedPaths.add(entry.relativePath);
      }
    }
  }
}

// ─── Entry Point ───────────────────────────────────────────────────────────

export async function handleInit() {
  const cwd = process.cwd();
  const devmindDir = path.join(cwd, '.devmind');
  const configPath = path.join(devmindDir, 'config.json');
  const envPath = path.join(devmindDir, '.env');
  const dbPath = path.join(devmindDir, 'brain.db');

  console.log(`🤖 Initializing DevsMind in: ${cwd}`);

  if (fs.existsSync(devmindDir) && fs.existsSync(configPath)) {
    console.log(`✨ Found existing DevsMind configuration at ${configPath}`);
    await handleExistingInit(devmindDir, configPath, envPath, dbPath);
  } else {
    console.log(`🆕 Creating a new DevsMind brain...`);
    await handleNewInit(cwd);
  }
}

// ─── Re-Init ───────────────────────────────────────────────────────────────

async function handleExistingInit(
  devmindDir: string,
  configPath: string,
  envPath: string,
  dbPath: string
) {
  const configContent = fs.readFileSync(configPath, 'utf-8');
  let config: DevMindConfig;
  try {
    config = JSON.parse(configContent) as DevMindConfig;
  } catch (err) {
    console.error(`❌ Error parsing config.json: ${(err as Error).message}`);
    return;
  }

  let envConfig: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    envConfig = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
  }

  const envLines: string[] = [];

  // ── Developer info check (all modes) ─────────────────────────
  const missingDev = !envConfig['DEVELOPER_NAME'] || !envConfig['DEVELOPER_EMAIL'];
  if (missingDev) {
    console.log(`\n👤 Developer info missing from .env:`);
    const detectedName = readGitConfig('user.name');
    const detectedEmail = readGitConfig('user.email');

    const devResponse = await prompts([
      {
        type: 'text',
        name: 'name',
        message: 'Your name?',
        initial: detectedName,
        validate: (v: string) => v.trim() ? true : 'Developer name is required'
      },
      {
        type: 'text',
        name: 'email',
        message: 'Your email?',
        initial: detectedEmail,
        validate: (v: string) => v.trim() ? true : 'Developer email is required'
      }
    ]);

    if (!devResponse.name) {
      console.log('❌ Initialization cancelled.');
      return;
    }

    envLines.push(`DEVELOPER_NAME=${devResponse.name.trim()}`);
    envLines.push(`DEVELOPER_EMAIL=${devResponse.email?.trim() || ''}`);
  } else {
    envLines.push(`DEVELOPER_NAME=${envConfig['DEVELOPER_NAME']}`);
    envLines.push(`DEVELOPER_EMAIL=${envConfig['DEVELOPER_EMAIL']}`);
  }

  // ── Mode-specific path validation ────────────────────────────
  if (config.mode === 'embedded') {
    console.log(`📦 Embedded mode — verifying relative repository paths...`);
    const projectRoot = path.dirname(devmindDir);
    let allOk = true;

    for (const repo of config.repos) {
      if ('relative_path' in repo) {
        const embeddedRepo = repo as EmbeddedRepoConfig;
        const fullPath = path.resolve(projectRoot, embeddedRepo.relative_path);
        if (!fs.existsSync(fullPath)) {
          console.warn(`⚠️  Repo "${repo.name}" not found at relative path: ${embeddedRepo.relative_path}`);
          allOk = false;
        } else {
          console.log(`✅ Repo "${repo.name}" OK (${embeddedRepo.relative_path})`);
        }
      }
    }

    if (allOk) console.log(`✅ All relative paths are valid.`);
  } else {
    console.log(`🌐 Standalone mode — checking repository paths in .env...`);

    const missingKeys: RepoConfig[] = [];
    const invalidPaths: { repo: RepoConfig; currentPath: string }[] = [];

    for (const repo of config.repos) {
      if ('path_key' in repo && repo.path_key) {
        const currentPath = envConfig[repo.path_key];
        if (!currentPath) {
          missingKeys.push(repo);
        } else if (!fs.existsSync(path.resolve(currentPath))) {
          invalidPaths.push({ repo, currentPath });
        } else {
          envLines.push(`${repo.path_key}=${currentPath}`);
        }
      }
    }

    // Keep unaffected existing keys (not repo paths, not dev info)
    for (const [key, value] of Object.entries(envConfig)) {
      const isRepoPath = config.repos.some(r => 'path_key' in r && r.path_key === key);
      const isDevKey = key === 'DEVELOPER_NAME' || key === 'DEVELOPER_EMAIL';
      if (!isRepoPath && !isDevKey) {
        envLines.push(`${key}=${value}`);
      }
    }

    if (missingKeys.length === 0 && invalidPaths.length === 0) {
      console.log(`✅ All repo paths are configured and valid.`);
    } else {
      console.log(`📝 Please configure paths for your repositories on this machine:`);
      const reposToPrompt = [...missingKeys, ...invalidPaths.map(ip => ip.repo)];

      for (const repo of reposToPrompt) {
        if ('path_key' in repo && repo.path_key) {
          const initialPath = envConfig[repo.path_key] || process.cwd();
          const response = await prompts({
            type: 'text',
            name: 'localPath',
            message: `Local path for repo "${repo.name}" (${repo.path_key})?`,
            initial: initialPath,
            validate: (val: string) => {
              const resolved = path.resolve(val);
              return fs.existsSync(resolved) ? true : `Directory does not exist: ${resolved}`;
            }
          });

          if (response.localPath === undefined) {
            console.log('❌ Initialization cancelled.');
            return;
          }

          envLines.push(`${repo.path_key}=${path.resolve(response.localPath)}`);
        }
      }
    }
  }

  // Write updated .env
  fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf-8');
  console.log(`💾 Updated ${envPath}`);

  // Ensure .gitignore exists
  const gitignorePath = path.join(devmindDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '.env\n', 'utf-8');
  }

  ensureDbInitialized(dbPath);
  console.log(`🎉 DevsMind initialization complete!`);
}

// ─── New Init ──────────────────────────────────────────────────────────────

async function handleNewInit(cwd: string) {
  const defaultProjectName = path.basename(cwd);

  // ── Step 1: Project name + mode ──────────────────────────────
  const baseResponse = await prompts([
    {
      type: 'text',
      name: 'projectName',
      message: 'Project name?',
      initial: defaultProjectName
    },
    {
      type: 'select',
      name: 'mode',
      message: 'Select the setup mode for this brain:',
      choices: [
        {
          title: 'Embedded (Single Git repo)',
          value: 'embedded',
          description: 'Lives inside the project repo. Relative paths — clone once, works everywhere.'
        },
        {
          title: 'Standalone (Multiple separate Git repos)',
          value: 'standalone',
          description: 'Its own folder/repo. Repo names shared via config; local paths in .env.'
        }
      ],
      initial: 0
    }
  ]);

  if (baseResponse.projectName === undefined || baseResponse.mode === undefined) {
    console.log('❌ Initialization cancelled.');
    return;
  }

  // ── Step 2: Resolve target directory ─────────────────────────
  let targetDir = '';
  let devmindDir = '';

  if (baseResponse.mode === 'embedded') {
    targetDir = cwd;
    devmindDir = path.join(targetDir, '.devmind');
  } else {
    const defaultFolderName = `${baseResponse.projectName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-brain`;

    const folderResponse = await prompts([
      {
        type: 'text',
        name: 'folderName',
        message: "Brain's folder name?",
        initial: defaultFolderName
      },
      {
        type: 'text',
        name: 'folderParent',
        message: 'Where do you want it to live?',
        initial: cwd,
        validate: (val: string) => {
          const resolved = path.resolve(val);
          return fs.existsSync(resolved) ? true : `Directory does not exist: ${resolved}`;
        }
      }
    ]);

    if (folderResponse.folderName === undefined || folderResponse.folderParent === undefined) {
      console.log('❌ Initialization cancelled.');
      return;
    }

    targetDir = path.join(path.resolve(folderResponse.folderParent), folderResponse.folderName);
    devmindDir = path.join(targetDir, '.devmind');

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      console.log(`📁 Created folder: ${targetDir}`);
    }
  }

  const configPath = path.join(devmindDir, 'config.json');
  const envPath = path.join(devmindDir, '.env');
  const dbPath = path.join(devmindDir, 'brain.db');

  const repos: RepoConfig[] = [];
  const envLines: string[] = [];
  const repoPaths: string[] = []; // Track actual FS paths for detection

  // ── Step 3: Configure repos ───────────────────────────────────
  const ignoredPaths: string[] = [];

  if (baseResponse.mode === 'embedded') {
    const repoName = baseResponse.projectName;
    repos.push({ name: repoName, relative_path: '.' } as EmbeddedRepoConfig);
    repoPaths.push(cwd);

    // Now configure exclusions for this repository folder
    console.log(`\n📂 Exclusions setup for repository folder "${repoName}":`);
    
    const currentExcluded = new Set<string>();
    // showIgnorePresets will prompt user for .gitignore patterns AND common presets
    await showIgnorePresets(currentExcluded, cwd);
    await runFileBrowser(cwd, currentExcluded);

    for (const p of currentExcluded) {
      ignoredPaths.push(p);
    }
  } else {
    console.log(`\n📦 Standalone Mode — Configure repositories for this brain`);
    let addAnother = true;
    let repoIndex = 1;

    while (addAnother) {
      console.log(`\n📦 Configuring Repository #${repoIndex}:`);
      const defaultName = repoIndex === 1 ? baseResponse.projectName : `service-${repoIndex}`;

      const repoResponse = await prompts([
        {
          type: 'text',
          name: 'name',
          message: 'Repository name?',
          initial: defaultName
        },
        {
          type: 'text',
          name: 'localPath',
          message: 'Local absolute path to this repository?',
          initial: cwd,
          validate: (val: string) => {
            const resolved = path.resolve(val);
            return fs.existsSync(resolved) ? true : `Directory does not exist: ${resolved}`;
          }
        }
      ]);

      if (repoResponse.name === undefined || repoResponse.localPath === undefined) {
        console.log('❌ Initialization cancelled.');
        return;
      }

      const pathKey = `REPO_${repoResponse.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      repos.push({ name: repoResponse.name, path_key: pathKey } as StandaloneRepoConfig);
      envLines.push(`${pathKey}=${path.resolve(repoResponse.localPath)}`);
      
      const absoluteRepoPath = path.resolve(repoResponse.localPath);
      repoPaths.push(absoluteRepoPath);

      // Now configure exclusions for this standalone repository
      console.log(`\n📂 Exclusions setup for repository "${repoResponse.name}":`);
      
      const currentExcluded = new Set<string>();
      // showIgnorePresets will prompt user for .gitignore patterns AND common presets
      await showIgnorePresets(currentExcluded, absoluteRepoPath);
      await runFileBrowser(absoluteRepoPath, currentExcluded);

      for (const p of currentExcluded) {
        ignoredPaths.push(p);
      }

      const loopResponse = await prompts({
        type: 'confirm',
        name: 'another',
        message: 'Would you like to add another repository to this brain?',
        initial: false
      });

      if (loopResponse.another === undefined) {
        console.log('❌ Initialization cancelled.');
        return;
      }

      addAnother = loopResponse.another;
      repoIndex++;
    }
  }

  // ── Step 4: Developer info (mandatory) ───────────────────────
  console.log(`\n👤 Developer info (stored in .env, gitignored — per developer):`);
  const detectedName = readGitConfig('user.name');
  const detectedEmail = readGitConfig('user.email');

  const devResponse = await prompts([
    {
      type: 'text',
      name: 'name',
      message: 'Your name?',
      initial: detectedName,
      validate: (v: string) => v.trim() ? true : 'Developer name is required'
    },
    {
      type: 'text',
      name: 'email',
      message: 'Your email?',
      initial: detectedEmail,
      validate: (v: string) => v.trim() ? true : 'Developer email is required'
    }
  ]);

  if (!devResponse.name) {
    console.log('❌ Initialization cancelled.');
    return;
  }

  envLines.push(`DEVELOPER_NAME=${devResponse.name.trim()}`);
  envLines.push(`DEVELOPER_EMAIL=${devResponse.email?.trim() || ''}`);

  // ── Step 6: Tech stack (auto from package.json) ───────────────
  let techStack: TechStack | undefined;
  const detected = detectTechStack(repoPaths);
  const hasDetected = (detected.languages?.length ?? 0) > 0 || (detected.frameworks?.length ?? 0) > 0;

  if (hasDetected) {
    console.log(`\n🛠️  Auto-detected tech stack:`);
    if (detected.languages?.length) console.log(`   Languages:  ${detected.languages.join(', ')}`);
    if (detected.frameworks?.length) console.log(`   Frameworks: ${detected.frameworks.join(', ')}`);

    const techConfirm = await prompts({
      type: 'confirm',
      name: 'correct',
      message: 'Does this look right?',
      initial: true
    });

    if (techConfirm.correct) {
      techStack = detected;
    } else {
      const techManual = await prompts([
        {
          type: 'list',
          name: 'languages',
          message: 'Languages? (comma separated)',
          initial: detected.languages?.join(', ') || '',
          separator: ','
        },
        {
          type: 'list',
          name: 'frameworks',
          message: 'Frameworks? (comma separated)',
          initial: detected.frameworks?.join(', ') || '',
          separator: ','
        }
      ]);
      techStack = {
        languages: (techManual.languages || []).map((l: string) => l.trim()).filter(Boolean),
        frameworks: (techManual.frameworks || []).map((f: string) => f.trim()).filter(Boolean)
      };
    }
  }

  // ── Step 7: Session timeout (optional, default 60) ────────────
  const timeoutResponse = await prompts({
    type: 'number',
    name: 'minutes',
    message: 'Session timeout in minutes? (default: 60 — press Enter to keep)',
    initial: 60,
    min: 5
  });
  const sessionTimeout: number = timeoutResponse.minutes ?? 60;

  // ── Step 8: Environments (optional) ───────────────────────────
  let environments: Record<string, string> | undefined;
  const addEnvs = await prompts({
    type: 'confirm',
    name: 'add',
    message: 'Add environment URLs? (dev, staging, prod) [optional]',
    initial: false
  });

  if (addEnvs.add) {
    environments = {};
    for (const envName of ['dev', 'staging', 'prod']) {
      const urlResponse = await prompts({
        type: 'text',
        name: 'url',
        message: `${envName} URL? (leave empty to skip)`
      });
      if (urlResponse.url?.trim()) {
        environments[envName] = urlResponse.url.trim();
      }
    }
    if (Object.keys(environments).length === 0) environments = undefined;
  }

  // ── Step 9: Notes (optional) ──────────────────────────────────
  const notesResponse = await prompts({
    type: 'text',
    name: 'notes',
    message: 'Any notes for the AI about this project? (optional)'
  });

  // ── Write files ───────────────────────────────────────────────
  if (!fs.existsSync(devmindDir)) {
    fs.mkdirSync(devmindDir, { recursive: true });
  }

  const config: DevMindConfig = {
    project_name: baseResponse.projectName,
    mode: baseResponse.mode,
    notes: notesResponse.notes || undefined,
    session_timeout_minutes: sessionTimeout !== 60 ? sessionTimeout : undefined,
    ignored_paths: ignoredPaths.length > 0 ? ignoredPaths : undefined,
    tech_stack: techStack,
    environments,
    repos
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`\n💾 Created ${configPath} (safe to commit to Git)`);

  // Always write .env — developer info is always local
  fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf-8');
  console.log(`💾 Created ${envPath} (local, gitignored)`);

  // Always create/update .gitignore to protect .env and ignore database/scratchpad
  const gitignorePath = path.join(devmindDir, '.gitignore');
  const ignoreContent = [
    '.env',
    'brain.db',
    'brain.db-wal',
    'brain.db-shm',
    'index_scratchpad.json'
  ].join('\n') + '\n';
  fs.writeFileSync(gitignorePath, ignoreContent, 'utf-8');
  console.log(`💾 Created/Updated ${gitignorePath}`);

  // Create graph and history directories with .gitkeep files so Git tracks them
  const graphDir = path.join(devmindDir, 'graph');
  const historyDir = path.join(devmindDir, 'history');
  if (!fs.existsSync(graphDir)) {
    fs.mkdirSync(graphDir, { recursive: true });
    fs.writeFileSync(path.join(graphDir, '.gitkeep'), '', 'utf-8');
  }
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, '.gitkeep'), '', 'utf-8');
  }

  ensureDbInitialized(dbPath);
  console.log(`🗄️  Initialized SQLite database at ${dbPath}`);

  console.log(`\n🎉 DevsMind Team AI Brain setup successfully completed!`);
  if (baseResponse.mode === 'standalone') {
    console.log(`💡 Next step: set DEVMIND_PATH = ${devmindDir} in your AI workspace rule.`);
  } else {
    console.log(`💡 Next step: run 'devsmind start' to launch the MCP server.`);
  }
}
