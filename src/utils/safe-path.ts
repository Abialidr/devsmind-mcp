// Deliberately well under Windows' 260 limit: the checkout directory a teammate cloned into is
// unknown here and can easily eat 60-100 characters, and a path that only fails on SOME machines is
// the worst kind to debug. Real brain paths are far shorter (the longest seen in practice is ~90).
const MAX_SAFE_REPO_PATH_LENGTH = 200;
/** Windows' MAX_PATH, less the terminating NUL. */
const WINDOWS_MAX_PATH = 259;
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface UnsafePathOptions {
  /**
   * Length of the directory this path will actually be materialized under, known when a check runs
   * on the machine that will do the checkout and `core.longpaths` is not in effect there. The limit
   * then tightens from the conservative default to what really fits: `259 - prefixLength`.
   */
  prefixLength?: number;
}

/**
 * True when a relative path (forward slashes, as git stores it) cannot be checked out on Windows,
 * and is therefore unsafe on a branch every teammate shares. The single definition used by every
 * guard — writers, the publish step, sync import, analyze, and the remote scan — so they can never
 * disagree about what "unsafe" means.
 *
 * Covers the characters Windows forbids, reserved device names, trailing dot/space, a length that
 * blows the path limit once a checkout directory is prepended, and the `", "` signature of two
 * absolute paths glued into one filename. Deliberately does not flag a bare comma: a real source
 * file may legitimately contain one. Case collisions are a property of a SET of paths, not one
 * path — see {@link findCaseCollisions}.
 */
export function isWindowsUnsafePath(relPath: string, opts: UnsafePathOptions = {}): boolean {
  const p = relPath;
  const limit = opts.prefixLength === undefined
    ? MAX_SAFE_REPO_PATH_LENGTH
    : Math.min(MAX_SAFE_REPO_PATH_LENGTH, WINDOWS_MAX_PATH - opts.prefixLength);
  if (p.length > limit) return true;
  // A literal backslash is unsafe too: git stores it as a filename character, Windows reads it as
  // a separator. Callers holding an OS-native path must convert it to `/` first.
  if (/[<>:"|?*\\\x00-\x1f]/.test(p) || p.includes(', ')) return true;
  return p.split('/').some(seg =>
    seg === '' || seg.endsWith('.') || seg.endsWith(' ') || WINDOWS_RESERVED_NAME_RE.test(seg)
  );
}

export const foldCase = (p: string): string => p.normalize('NFC').toLowerCase();

/** Every ancestor directory of a `/`-separated path, shortest first (`a/b/c.json` → `a`, `a/b`). */
export function ancestorDirs(p: string): string[] {
  const segs = p.split('/');
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join('/'));
  return out;
}

/**
 * Paths that must be dropped from a set because Windows and macOS (case-insensitive, and on macOS
 * Unicode-normalizing) could not materialize it faithfully. Three shapes, all decided
 * deterministically so every machine, given the same set, drops the same files:
 *
 *  - two FILES differing only by case/normalization (`Foo.json` / `foo.json`): the first in
 *    code-point order survives;
 *  - two DIRECTORIES differing only by case (`App/` / `app/`): the first survives and every file
 *    under the other is dropped — otherwise both trees pour into one folder and overwrite each
 *    other whenever a name repeats;
 *  - a FILE whose name matches a directory's (`foo` / `Foo/bar`): the file is dropped, since a
 *    path cannot be both on a case-insensitive filesystem.
 */
export function findCaseCollisions(paths: Iterable<string>): string[] {
  const files = [...new Set(paths)];
  const dirVariants = new Map<string, Set<string>>();
  const ancestors = ancestorDirs;
  for (const f of files) {
    for (const dir of ancestors(f)) {
      const k = foldCase(dir);
      let s = dirVariants.get(k);
      if (!s) dirVariants.set(k, (s = new Set()));
      s.add(dir);
    }
  }

  const losingDirs = new Set<string>();
  for (const variants of dirVariants.values()) {
    if (variants.size > 1) for (const d of [...variants].sort().slice(1)) losingDirs.add(d);
  }

  const drop = new Set<string>();
  for (const f of files) {
    if (dirVariants.has(foldCase(f)) || ancestors(f).some(d => losingDirs.has(d))) drop.add(f);
  }

  const groups = new Map<string, string[]>();
  for (const f of files) {
    if (drop.has(f)) continue;
    const k = foldCase(f);
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }
  for (const g of groups.values()) {
    if (g.length > 1) for (const f of g.sort().slice(1)) drop.add(f);
  }
  return [...drop];
}

// Top-level directories of an OS, never a project. A generated path that begins with one is another
// machine's absolute path (`/home/u/app/x.ts`) with its leading slash stripped.
const FOREIGN_ROOT_DIRS = new Set(['home', 'users', 'root', 'mnt', 'volumes', 'tmp', 'var', 'usr', 'opt', 'etc', 'srv']);

/**
 * True when `firstSegment` — the directory directly under `graph/` or `vectors/` — is an operating
 * system's root directory rather than a repo name. This is the one kind of "Windows-safe but wrong"
 * path that can be recognized WITHOUT knowing which repos a teammate has configured: no repo name
 * is checked against a list that may be incomplete (a repo skipped on this machine is still valid
 * data), only against the names of OS directories — and a repo that genuinely carries such a name is
 * exempted through `repoNames`.
 */
export function isForeignRootSegment(firstSegment: string, repoNames: Iterable<string> = []): boolean {
  const seg = firstSegment.toLowerCase();
  if (!FOREIGN_ROOT_DIRS.has(seg)) return false;
  for (const n of repoNames) if (n.toLowerCase() === seg) return false;
  return true;
}

/**
 * True when `filePath` is an absolute path that belongs to a DIFFERENT platform than `platform` —
 * a teammate's Windows path on a Mac, a teammate's Linux path on Windows, and so on. Pure, with the
 * platform passed in, so every platform's branch can be tested from any machine.
 *
 * On macOS `/home/` and `/root/` are never real (a Linux path); on Linux `/Users/` is never real (a
 * Mac path). Windows-style paths are foreign to both.
 */
export function isForeignAbsolutePath(filePath: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    // A posix-rooted path (no drive, not a `\\server` UNC path), or the artifact a Linux path leaves
    // behind once Windows resolves it against the current drive (`c:\home\u\...`). Deliberately NOT
    // a substring test: `C:\Users\me\...` is every Windows profile path and must stay native.
    return /^\/(?!\/)/.test(filePath) || /^[a-zA-Z]:[\\/]home[\\/]/i.test(filePath);
  }
  if (/^[a-zA-Z]:/.test(filePath) || filePath.includes('\\')) return true;
  return platform === 'darwin' ? /^\/(home|root)\//.test(filePath) : /^\/Users\//.test(filePath);
}
