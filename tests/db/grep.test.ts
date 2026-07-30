import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepRepos, rankGrepHits } from '../../src/db/grep';

function makeRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsmind-grep-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('grepRepos ignore handling', () => {
  it('skips the mobile/native build dirs (Pods, .dart_tool, .gradle, DerivedData, .expo, Carthage, .symlinks) by default', async () => {
    const repo = makeRepo({
      'ios/Pods/SomeLib/lib.m': 'needle',
      '.dart_tool/generated.dart': 'needle',
      'android/.gradle/cache.txt': 'needle',
      'DerivedData/build.log': 'needle',
      '.expo/cache.json': 'needle',
      'Carthage/Build/lib.txt': 'needle',
      '.symlinks/plugins/lib.dart': 'needle',
      'lib/keep.dart': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle');
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('keep.dart'))).toBe(true);
      expect(files.some(f => f.includes('/Pods/'))).toBe(false);
      expect(files.some(f => f.includes('/.dart_tool/'))).toBe(false);
      expect(files.some(f => f.includes('/.gradle/'))).toBe(false);
      expect(files.some(f => f.includes('/DerivedData/'))).toBe(false);
      expect(files.some(f => f.includes('/.expo/'))).toBe(false);
      expect(files.some(f => f.includes('/Carthage/'))).toBe(false);
      expect(files.some(f => f.includes('/.symlinks/'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('honors a multi-segment ignored_paths entry (e.g. "ios/Pods"), not just a bare directory name', async () => {
    const repo = makeRepo({
      'ios/Pods/SomeLib/lib.m': 'needle',
      'ios/keep.m': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { ignoredPaths: ['ios/Pods'] });
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('lib.m') && f.includes('Pods'))).toBe(false);
      expect(files.some(f => f.endsWith('keep.m'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('does not treat an ignored name as a prefix — a sibling like "outbound" survives ignoring "out"', async () => {
    const repo = makeRepo({
      'out/build.ts': 'needle',
      'outbound/client.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle');
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('build.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('client.ts'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('skips lockfiles and build artifacts by default, but NOT .env or ordinary JSON', async () => {
    // A lockfile names every dependency in the tree, so a product term like "alipay" matches it
    // incidentally and outranks the real source. `.env` and plain JSON are the opposite case —
    // the files bucket exists precisely to cover config the graph doesn't index, and both the
    // tool description and the seeded agent memory advertise `.env` by name.
    const repo = makeRepo({
      'package-lock.json': 'needle',
      'yarn.lock': 'needle',
      'Podfile.lock': 'needle',
      'go.sum': 'needle',
      'dist-assets/app.min.js': 'needle',
      'dist-assets/app.js.map': 'needle',
      '.env': 'needle',
      'translations/en.json': 'needle',
      'src/real.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle');
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('/package-lock.json'))).toBe(false);
      expect(files.some(f => f.endsWith('/yarn.lock'))).toBe(false);
      expect(files.some(f => f.endsWith('/Podfile.lock'))).toBe(false);
      expect(files.some(f => f.endsWith('/go.sum'))).toBe(false);
      expect(files.some(f => f.endsWith('.min.js'))).toBe(false);
      expect(files.some(f => f.endsWith('.map'))).toBe(false);
      // Still searchable — excluding these would silently reverse a documented capability.
      expect(files.some(f => f.endsWith('/.env'))).toBe(true);
      expect(files.some(f => f.endsWith('/en.json'))).toBe(true);
      expect(files.some(f => f.endsWith('/real.ts'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('matches denied names exactly, not as a prefix — package-lock.json.bak is still searched', async () => {
    const repo = makeRepo({
      'package-lock.json.bak': 'needle',
      'notes.map.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle');
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('package-lock.json.bak'))).toBe(true);
      // `.map` is a SUFFIX rule, so a file merely containing ".map" mid-name must survive.
      expect(files.some(f => f.endsWith('notes.map.ts'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('honors a FILE name in ignored_paths, not just a directory', async () => {
    // The regression this locks in: `ignored_paths` was only ever consulted on directory entries,
    // so every FILE the user excluded was silently searched anyway. `devsmind init`'s own preset
    // list is entirely file names, so this was the common case, not an edge one.
    const repo = makeRepo({
      'tsconfig.json': 'needle',
      'src/keep.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { ignoredPaths: ['tsconfig.json'] });
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('/tsconfig.json'))).toBe(false);
      expect(files.some(f => f.endsWith('/keep.ts'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('honors a leading-slash ignored_paths entry, the form .gitignore uses to anchor at the repo root', async () => {
    // "/dist" survives .gitignore import (no glob metacharacter), but only the TRAILING slash was
    // stripped — so the test became `.includes('//dist/')`, a doubled slash no real path contains,
    // and the entry matched nothing at all, silently.
    const repo = makeRepo({
      'generated/out.ts': 'needle',
      'src/keep.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { ignoredPaths: ['/generated'] });
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('/out.ts'))).toBe(false);
      expect(files.some(f => f.endsWith('/keep.ts'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  it('a scopePath pointing straight AT a denied file finds nothing, same as scoping at an ignored dir', async () => {
    const repo = makeRepo({ 'yarn.lock': 'needle' });
    try {
      const result = await grepRepos([repo.root], 'needle', { scopePath: path.join(repo.root, 'yarn.lock') });
      expect(result.hits).toEqual([]);
    } finally {
      repo.cleanup();
    }
  });
});

describe('grepRepos regex pattern', () => {
  it('matches alternation branches — the motivating case: heartRed|onLikeTap|item\\.liked', async () => {
    const repo = makeRepo({
      'a.js': 'const heartRed = 1;\nfunction onLikeTap() {}\nconst x = item.liked;\n'
    });
    try {
      const result = await grepRepos([repo.root], 'heartRed|onLikeTap|item\\.liked');
      const texts = result.hits.map(h => h.matched_text).sort();
      expect(texts).toEqual(['heartred', 'item.liked', 'onliketap']);
    } finally {
      repo.cleanup();
    }
  });

  it('an escaped dot matches a literal dot but NOT an arbitrary character (the bug this fixes)', async () => {
    const repo = makeRepo({
      'a.js': 'item.liked\nitemXliked\n'
    });
    try {
      const result = await grepRepos([repo.root], 'item\\.liked');
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].line_content).toBe('item.liked');
    } finally {
      repo.cleanup();
    }
  });

  it('is case-insensitive by default and honors case_insensitive: false', async () => {
    const repo = makeRepo({ 'a.js': 'const NeedleValue = 1;\n' });
    try {
      const insensitive = await grepRepos([repo.root], 'needlevalue');
      expect(insensitive.hits).toHaveLength(1);
      const sensitive = await grepRepos([repo.root], 'needlevalue', { caseInsensitive: false });
      expect(sensitive.hits).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });

  it('throws a clear "Invalid regex pattern" error for a malformed pattern', async () => {
    const repo = makeRepo({ 'a.js': 'x\n' });
    try {
      await expect(grepRepos([repo.root], '(unclosed')).rejects.toThrow('Invalid regex pattern');
    } finally {
      repo.cleanup();
    }
  });

  it('a zero-length-match-prone pattern (x*) terminates instead of hanging', async () => {
    const repo = makeRepo({ 'a.js': 'no matching letter here\n'.repeat(50) });
    try {
      const result = await grepRepos([repo.root], 'x*');
      // Must complete at all (the real assertion is that this test doesn't time out) and never
      // record a zero-length "match".
      expect(result.hits.every(h => h.matched_text.length > 0)).toBe(true);
    } finally {
      repo.cleanup();
    }
  }, 5000);
});

describe('grepRepos path scoping', () => {
  it('restricts the walk to a single subfolder', async () => {
    const repo = makeRepo({
      'src/a.ts': 'needle',
      'other/b.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { scopePath: path.join(repo.root, 'src') });
      const files = result.hits.map(h => h.file_path.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('src/a.ts'))).toBe(true);
      expect(files.some(f => f.endsWith('other/b.ts'))).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('restricts the walk to a single file', async () => {
    const repo = makeRepo({
      'src/a.ts': 'needle',
      'src/b.ts': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { scopePath: path.join(repo.root, 'src', 'a.ts') });
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].file_path.replace(/\\/g, '/')).toMatch(/a\.ts$/);
    } finally {
      repo.cleanup();
    }
  });

  it('a scope path pointing straight into an ignored dir (node_modules) yields nothing', async () => {
    const repo = makeRepo({
      'node_modules/pkg/index.js': 'needle'
    });
    try {
      const result = await grepRepos([repo.root], 'needle', { scopePath: path.join(repo.root, 'node_modules') });
      expect(result.hits).toHaveLength(0);
    } finally {
      repo.cleanup();
    }
  });
});

describe('rankGrepHits totals and pagination', () => {
  it('reports the true total distinct files independent of the page size', async () => {
    const repo = makeRepo({
      'a.ts': 'needle', 'b.ts': 'needle', 'c.ts': 'needle'
    });
    try {
      const grep = await grepRepos([repo.root], 'needle');
      const page = rankGrepHits(grep.hits, { maxFiles: 2 });
      expect(page.files).toHaveLength(2);
      expect(page.total).toBe(3);
    } finally {
      repo.cleanup();
    }
  });

  it('offset pages are disjoint and stably ordered across repeated calls', async () => {
    const repo = makeRepo({
      'a.ts': 'needle', 'b.ts': 'needle', 'c.ts': 'needle'
    });
    try {
      const grep = await grepRepos([repo.root], 'needle');
      const page1 = rankGrepHits(grep.hits, { maxFiles: 2, offset: 0 });
      const page2 = rankGrepHits(grep.hits, { maxFiles: 2, offset: 2 });
      const page1Again = rankGrepHits(grep.hits, { maxFiles: 2, offset: 0 });
      expect(page1.files.map(f => f.file_path)).toEqual(page1Again.files.map(f => f.file_path));
      const seen = new Set([...page1.files, ...page2.files].map(f => f.file_path));
      expect(seen.size).toBe(3); // no repeats, no gaps across the two pages
    } finally {
      repo.cleanup();
    }
  });
});
