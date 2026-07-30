import * as fs from 'fs';
import * as path from 'path';
import { makeFixture } from '../helpers/fixture';
import { scanRepoFiles, INDEXABLE_EXTENSIONS } from '../../src/utils/scanner';

// `import * as fs` (under esModuleInterop) produces a non-configurable namespace wrapper that
// jest.spyOn cannot redefine. A plain `require('fs')` returns the real, mutable Node module
// object — the same singleton the source file's `fs.xxx` getters proxy back to — so spying here
// still intercepts calls made from src/utils/scanner.ts.
const fsReal: typeof fs = require('fs');

describe('scanRepoFiles', () => {
  it('includes indexable extensions and excludes non-indexable ones', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'main.go': 'package main',
        'app.py': 'print(1)',
        'Component.vue': '<template></template>',
        'notes.md': '# notes',
        'style.css': 'body {}'
      }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      expect(result.repos).toHaveLength(1);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('main.go'))).toBe(true);
      expect(files.some(f => f.endsWith('app.py'))).toBe(true);
      expect(files.some(f => f.endsWith('Component.vue'))).toBe(true);
      expect(files.some(f => f.endsWith('notes.md'))).toBe(false);
      expect(files.some(f => f.endsWith('style.css'))).toBe(false);
      expect(result.repos[0].file_count).toBe(files.length);
      expect(result.repos[0].repo_name).toBe('app');
      expect(result.total_files).toBe(files.length);
    } finally {
      fx.cleanup();
    }
  });

  it('skips ALWAYS_IGNORED directories regardless of config', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'node_modules/lib.ts': 'export const x = 1;',
        '.git/config.ts': 'export const y = 1;',
        'dist/out.ts': 'export const z = 1;',
        'build/out.ts': 'export const w = 1;',
        'out/out.ts': 'export const v = 1;',
        '.next/out.ts': 'export const u = 1;',
        '__pycache__/mod.py': 'x = 1',
        '.venv/mod.py': 'x = 1',
        'venv/mod.py': 'x = 1',
        'coverage/report.ts': 'export const t = 1;',
        '.turbo/cache.ts': 'export const s = 1;',
        '.cache/cache.ts': 'export const r = 1;',
        '.idea/x.ts': 'export const q = 1;',
        '.vscode/x.ts': 'export const p = 1;',
        'src/keep.ts': 'export const keep = 1;'
      }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('keep.ts'))).toBe(true);
      expect(files).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });

  it('respects config.ignored_paths on top of the always-ignored set', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      configOverrides: { ignored_paths: ['legacy'] },
      extraFiles: {
        'legacy/old.ts': 'export const old = 1;',
        'current/new.ts': 'export const fresh = 1;'
      }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('old.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('new.ts'))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('honors a leading-slash ignored_paths entry, the form .gitignore uses to anchor at the repo root', () => {
    // "/legacy" survives .gitignore import (it has no glob metacharacter), but only the TRAILING
    // slash was stripped — so the match became `.includes('//legacy/')`, a doubled slash no real
    // path contains, and the entry silently excluded nothing.
    const fx = makeFixture({
      skipDefaultFiles: true,
      configOverrides: { ignored_paths: ['/legacy'] },
      extraFiles: {
        'legacy/old.ts': 'export const old = 1;',
        'current/new.ts': 'export const fresh = 1;'
      }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('old.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('new.ts'))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('does not treat an ignored name as a prefix — a sibling like "outbound" survives ignoring "out"', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      configOverrides: { ignored_paths: ['legacy'] },
      extraFiles: {
        'out/build.ts': 'export const built = 1;',
        'outbound/client.ts': 'export const client = 1;',
        'legacy/old.ts': 'export const old = 1;',
        'legacy-utils/helper.ts': 'export const helper = 1;'
      }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('build.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('old.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('client.ts'))).toBe(true);
      expect(files.some(f => f.endsWith('helper.ts'))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('reports "(path not configured)" for a repo whose relative_path does not resolve', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      configOverrides: {
        repos: [
          { name: 'app', relative_path: 'src-repo' },
          { name: 'unconfigured', relative_path: '' }
        ]
      },
      extraFiles: { 'ok.ts': 'export const ok = 1;' }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      expect(result.repos).toHaveLength(2);
      const app = result.repos.find(r => r.repo_name === 'app')!;
      expect(app.files.some(f => f.endsWith('ok.ts'))).toBe(true);
      const unconfigured = result.repos.find(r => r.repo_name === 'unconfigured')!;
      expect(unconfigured.repo_path).toBe('(path not configured)');
      expect(unconfigured.files).toEqual([]);
      expect(unconfigured.file_count).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('returns zero total_files for a repo with no indexable content', () => {
    const fx = makeFixture({ skipDefaultFiles: true, extraFiles: { 'readme.md': '# hi' } });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      expect(result.total_files).toBe(0);
      expect(result.repos[0].files).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('returns an empty file list (without throwing) for a resolved repo path that does not exist on disk', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      configOverrides: { repos: [{ name: 'app', relative_path: 'ghost-repo' }] }
    });
    try {
      const result = scanRepoFiles(fx.devmindPath);
      expect(result.repos).toHaveLength(1);
      expect(result.repos[0].repo_path).toContain('ghost-repo');
      expect(result.repos[0].files).toEqual([]);
      expect(result.total_files).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it('skips a subdirectory (and does not throw) when readdirSync fails on it, e.g. a permission error', () => {
    const fx = makeFixture({
      skipDefaultFiles: true,
      extraFiles: {
        'locked/inner.ts': 'export const inner = 1;',
        'kept.ts': 'export const kept = 1;'
      }
    });
    const lockedDir = path.join(fx.repoDir, 'locked');
    const originalReaddirSync = fsReal.readdirSync.bind(fsReal);
    const readdirSpy = jest.spyOn(fsReal, 'readdirSync').mockImplementation(((dir: fs.PathLike, ...rest: any[]) => {
      if (path.resolve(dir.toString()) === path.resolve(lockedDir)) {
        throw new Error('EACCES: permission denied');
      }
      return (originalReaddirSync as any)(dir, ...rest);
    }) as any);
    try {
      const result = scanRepoFiles(fx.devmindPath);
      const files = result.repos[0].files.map(f => f.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('kept.ts'))).toBe(true);
      expect(files.some(f => f.endsWith('inner.ts'))).toBe(false);
    } finally {
      readdirSpy.mockRestore();
      fx.cleanup();
    }
  });

  it('exposes the exact INDEXABLE_EXTENSIONS set', () => {
    expect([...INDEXABLE_EXTENSIONS].sort()).toEqual(
      [
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
        '.py', '.go', '.java', '.cs', '.rb', '.php',
        '.rs', '.swift', '.kt', '.dart', '.vue', '.svelte'
      ].sort()
    );
  });
});
