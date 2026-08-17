import * as fs from 'fs';
import * as path from 'path';

/**
 * A fast, dependency-free filesystem grep — the "last resort" file layer of `search_nodes`,
 * and the thing that lets it finally cover files the graph never indexes (CSS, JSON, config,
 * markup, un-indexed code). Deliberately self-contained: no DB, no MCP, so it can be unit-tested
 * in isolation and reasoned about purely as "given roots + a pattern, return where it appears".
 *
 * The pattern is a REAL regex — not escaped, not split on a delimiter. An agent can pass exactly
 * what it would give `grep`: alternation (`a|b`), escaped literals (`item\.liked`), character
 * classes, anything. Earlier versions took a list of literal `keywords`, escaped each one, and
 * OR-joined them — which meant an agent passing its OWN already-correct regex (e.g.
 * `item\.liked`) got it re-escaped into a search for a literal backslash, silently matching
 * nothing. That mismatch between what the caller wrote and what the tool actually searched for
 * is the whole reason for this rewrite.
 *
 * Performance is the whole point: the tool is only worth using if it's as fast as grep, or the
 * AI just reaches for grep instead. So this does ONE walk over each repo, tests the pattern in a
 * single compiled regex per line, skips junk dirs / binary / oversized files before ever reading
 * them, and hard-stops at a deadline with a partial result rather than ever blowing the budget.
 *
 * Walking and reading are both SYNCHRONOUS (`fs.readdirSync`/`fs.statSync`/`fs.readFileSync`), not
 * `fs.promises` + bounded concurrency as an earlier version did. That sounds like it should be
 * slower — it isn't. Every `fs.promises` call queues onto Node's libuv threadpool, which defaults
 * to just 4 threads; "bounded concurrency" in JS-land doesn't mean bounded OS-level parallelism,
 * it means potentially thousands of promises competing for 4 real workers, and on Windows especially
 * (antivirus adds latency to every filesystem call) that queuing dominated wall-clock time. Measured
 * against a real 8-repo production checkout: the async version took multiple MINUTES per search on
 * some queries; sync took low hundreds of milliseconds for the identical walk. Sync fs calls bypass
 * the threadpool entirely — a brief main-thread block for a fast operation beats a "concurrent" one
 * queued behind a 4-worker bottleneck.
 */

/** Directories never worth searching — build output, deps, VCS internals. Mirrors scanner.ts. */
const ALWAYS_IGNORED = [
  'node_modules', '.git', 'dist', 'build', 'out', '.next',
  '__pycache__', '.venv', 'venv', 'coverage', '.turbo',
  '.cache', '.idea', '.vscode', '.devsmind', '.devmind',
  // Mobile/native build & dependency caches — not JS/Python-shaped, so the list above misses
  // them entirely. Left out originally, these are exactly the giant, non-source directories
  // (hundreds of thousands of files in Pods/DerivedData on a real iOS checkout) that a
  // path-blind grep walk would otherwise crawl on every single search.
  '.dart_tool', '.gradle', '.symlinks', 'Pods', 'DerivedData', '.expo', 'Carthage'
];

/**
 * Individual FILES never worth grepping, matched on basename. Every entry here is machine-written:
 * a dependency resolution dump or a build artifact. They are the single biggest source of false
 * positives in a real search — a lockfile mentions every package name in the tree, so a pattern
 * like `alipay|Alipay` matches `yarn.lock` and `package-lock.json` purely because a dependency is
 * named that, ranking them alongside the actual source the agent was looking for.
 *
 * Note what is deliberately NOT here: `.env`. The file-level doc comment above, the `search_nodes`
 * tool description, and the generated agent memory all advertise the files bucket as how you find
 * "CSS, JSON, .env, markup" — "which env var drives this" is a documented, intended use. Excluding
 * it by default would silently reverse a shipped contract. A user who wants it gone can still put
 * it in `ignored_paths`, which IS honored per-file now (see `shouldIgnorePath`).
 *
 * Exact basenames, not globs, on purpose: `ignored_paths` has no glob engine (init.ts filters glob
 * lines out of .gitignore import and tells the user so), and a built-in list that spoke a language
 * the user's own config couldn't would be its own trap. `DENIED_SUFFIXES` covers the few cases
 * that genuinely need a wildcard, via plain `endsWith`.
 */
const DENIED_BASENAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'bun.lockb',
  'composer.lock', 'Gemfile.lock', 'poetry.lock', 'Cargo.lock', 'Podfile.lock', 'pubspec.lock',
  'go.sum'
]);

/** Generated/derived files, matched on suffix — minified bundles and source maps. */
const DENIED_SUFFIXES = ['.min.js', '.min.css', '.map'];

/**
 * True if a path is a lockfile or build artifact excluded from search by default. Exported so
 * `searchNodes` can tell an agent that explicitly scoped `path` AT such a file WHY it got nothing
 * back, rather than leaving it to read as "the pattern isn't in there".
 */
export function isDefaultIgnoredFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return DENIED_BASENAMES.has(base) || DENIED_SUFFIXES.some(sfx => base.endsWith(sfx));
}

/** Files above this are almost never hand-written source worth grepping (minified bundles, data dumps). */
const MAX_FILE_BYTES = 1_000_000;
/** Bytes sniffed from the head of a file to decide "is this binary" (a NUL byte ⇒ binary). */
const BINARY_SNIFF_BYTES = 4096;
/** Caps matches recorded per line — a pathological line (a minified bundle that slipped past the
 * size/binary filters, or a pattern like `.` against a long line) shouldn't blow up memory. */
const MAX_MATCHES_PER_LINE = 20;

export interface GrepHit {
  file_path: string;
  line_number: number;
  line_content: string;
  /** The actual substring the regex matched at this hit (lowercased) — used to attribute and
   * rank matches without needing a fixed keyword list, since the pattern may be a single regex
   * with no discrete "terms" of its own (e.g. `on\w+Tap`). */
  matched_text: string;
}

export interface GrepResult {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
}

export interface RankedFile {
  file_path: string;
  total_matches: number;
  /** Per-matched-text counts in this file — how the AI sees which part of the pattern actually landed. */
  match_counts: Record<string, number>;
  /** How many DISTINCT matched strings landed here — the strongest relevance signal. */
  distinct_matches: number;
  score: number;
  /** A few representative matching lines (capped), for the AI to eyeball without opening the file.
   * `symbol` — the containing function/class, when resolvable — is populated by the CALLER
   * (`DevMindDatabase.annotateSampleLinesWithSymbol`), never by grep.ts itself: this module is
   * deliberately dependency-free (no DB/AST access), see the file-level doc comment. */
  sample_lines: { line_number: number; line_content: string; symbol?: string }[];
}

/** `rankGrepHits`' result: a capped page of files plus the TRUE total, so the caller can tell
 * "nothing more to find" from "more exists past this page" instead of guessing from a bare list. */
export interface RankGrepHitsResult {
  files: RankedFile[];
  /** Total distinct files that matched, before the `maxFiles`/`offset` page was cut. */
  total: number;
}

/**
 * Path-segment-aware, mirroring scanner.ts's `shouldIgnore` exactly (kept as a separate copy,
 * not a shared import — grep.ts is deliberately dependency-free, see the file-level doc comment).
 *
 * This used to be a bare `ALWAYS_IGNORED.includes(name) || extraIgnored.includes(name)` — an
 * EXACT match against just the current directory's basename. That silently failed to honor any
 * multi-segment `ignored_paths` entry (e.g. "ios/Pods", or a path picked via the `devsmind init`
 * folder browser, which stores a path like "ios/Pods" rather than the bare name "Pods"): walking
 * into a directory literally named "Pods" tested `"ios/Pods".includes("Pods")` against the wrong
 * variable — `extraIgnored.includes(name)` checks array membership of "Pods" against the literal
 * string "ios/Pods", which is never true. The directory was walked (and every file in it read)
 * on every single search regardless of the exclusion the user explicitly configured. Same root
 * cause the file-level doc comment already documents for enumeration cost in general: this was
 * the biggest reason a single un-ignored deep native-deps folder could dominate `search_nodes`
 * latency even after the user had "already excluded it."
 *
 * Named `shouldIgnorePath`, not `shouldIgnoreDir`, because it is applied to FILE entries too now.
 * It always could be — the matching is on the full path, so `".../package-lock.json"` correctly
 * satisfies `endsWith("/package-lock.json")`. It simply was never called on the file branch of
 * the walk, which meant every FILE entry a user had put in `ignored_paths` was silently inert for
 * search. That was not a rare configuration: `devsmind init`'s own preset list is entirely file
 * names (package-lock.json, yarn.lock, tsconfig.json…), and .gitignore import passes literal file
 * names straight through. Users had excluded these, seen them keep showing up in every result,
 * and had no way to tell the exclusion was being dropped on the floor. `scanner.ts` applies the
 * equivalent check to files correctly; grep.ts was the outlier.
 *
 * The leading-slash strip matters for the same class of reason: `.gitignore` conventionally writes
 * a repo-root anchor as `/dist`, and `isLiteralIgnorePattern` accepts it (there is no glob
 * metacharacter in it), so it lands in `ignored_paths` verbatim. Stripping only the TRAILING slash
 * left the test as `normalized.includes('//dist/')` — a doubled slash that can never occur in a
 * real path, so the entry matched nothing, forever, in silence.
 */
function shouldIgnorePath(fullPath: string, extraIgnored: string[]): boolean {
  const normalized = fullPath.replace(/\\/g, '/');
  const allIgnored = [...ALWAYS_IGNORED, ...extraIgnored];
  return allIgnored.some(pattern => {
    const p = pattern.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
    return normalized.includes(`/${p}/`) || normalized.endsWith(`/${p}`);
  });
}

/** Escapes a literal string so it matches as text, not as a regex pattern. Exported so callers
 * building a regex out of LITERAL terms (e.g. `searchNodes` deriving one from query tokens when
 * no explicit `pattern` was given) can reuse the exact same escaping grep.ts uses internally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recursively lists every candidate file under a root, skipping junk dirs. Enumeration only — no
 * file contents are read here.
 *
 * `root` may be a single FILE, not just a directory — this is what makes `path` scoping to one
 * file work: `readdirSync` throws on a file, so that case is checked up front and short-circuits
 * to a one-element result instead of falling into the directory walk.
 *
 * SYNCHRONOUS on purpose, not `fsp.readdir` fanned out via `Promise.all`. Every `fs.promises` call
 * queues onto Node's libuv threadpool, which defaults to just 4 threads — an unbounded
 * `Promise.all(subdirs.map(walk))` doesn't give the OS real parallelism, it just piles hundreds or
 * thousands of directory-listing promises onto that tiny pool. On Windows in particular (real-time
 * antivirus scanning adds latency to every single filesystem call), that queuing turned a walk of
 * real 8-repo, ~3500-file trees — 32ms with plain synchronous `readdirSync` — into multi-MINUTE
 * enumeration times, measured against a real production checkout. `readdirSync` bypasses the
 * threadpool entirely (it's one direct syscall per directory), which is why it doesn't have this
 * problem. A brief synchronous block for a fast operation beats a "concurrent" one queued behind a
 * 4-worker bottleneck.
 *
 * Deadline-checked between every directory (not just, as before, only in the file-read phase) —
 * `listFiles` alone used to have NO way to bail out early, so a single pathological repo could
 * blow the entire search budget before the read phase's own deadline check ever ran. Returns
 * whatever was found so far plus `truncated: true` if the deadline hit mid-walk.
 */
function listFiles(root: string, extraIgnored: string[], deadline: number): { files: string[]; truncated: boolean } {
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return { files: [], truncated: false }; // doesn't exist / unreadable — nothing to search
  }
  if (rootStat.isFile()) return { files: [root], truncated: false };

  const out: string[] = [];
  let truncated = false;

  function walk(dir: string): void {
    if (truncated) return;
    if (timeMonotonic() > deadline) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the whole search
    }
    for (const entry of entries) {
      if (truncated) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldIgnorePath(fullPath, extraIgnored)) walk(fullPath);
      } else if (entry.isFile()) {
        // Files are filtered here, at enumeration, not later in `grepFile` — a lockfile is
        // typically a few hundred KB of non-binary text, so it clears every check `grepFile`
        // makes (size, NUL sniff) and gets read and scanned in full on every single search.
        if (!isDefaultIgnoredFile(fullPath) && !shouldIgnorePath(fullPath, extraIgnored)) {
          out.push(fullPath);
        }
      }
    }
  }
  walk(root);
  return { files: out, truncated };
}

/** True if the head of the buffer contains a NUL byte — the standard cheap "is binary" heuristic. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Reads one file and collects every line matching the regex. Returns [] on any read error, binary
 * content, or oversize — a single bad file never breaks the search.
 *
 * `matcher` MUST carry the `g` flag (the caller builds it once and reuses it across every file) —
 * without it there is no way to find every match on a line, only the first. `lastIndex` is reset
 * per line since a stateful global regex otherwise silently skips matches or scans stale offsets
 * from the PREVIOUS line.
 *
 * Zero-length matches are a real hazard with an arbitrary caller-supplied pattern (e.g. `x*`
 * against a line with no "x" still "matches" at every position with length 0): `exec` never
 * advances `lastIndex` on its own for those, so a naive loop spins forever at the same index.
 * Guarded by force-advancing whenever `lastIndex` didn't move — the standard fix for this exact
 * MDN-documented `RegExp.exec` footgun.
 *
 * SYNCHRONOUS on purpose (`fs.statSync`/`fs.readFileSync`), same reasoning as `listFiles`: this
 * used to be `fsp.stat`/`fsp.readFile` run through a 24-way `mapPool`, which sounds like real
 * parallelism but every one of those calls queues onto Node's 4-thread libuv threadpool — on a
 * real repo tree (thousands of files, many of them non-source assets a `public/`-style directory
 * pulls in) that queuing, not the actual I/O, was the dominant cost, especially on Windows where
 * antivirus adds latency per filesystem call. Measured on a real production checkout: converting
 * this phase from bounded-async to plain sync took what could run into MINUTES down to comfortably
 * under the search budget. "Bounded concurrency" isn't a meaningful concept for sync calls anyway
 * — they're inherently one-at-a-time — so the caller now just loops with a deadline check between
 * files instead of pooling workers.
 */
function grepFile(filePath: string, matcher: RegExp): GrepHit[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];

  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return [];
  }
  if (looksBinary(buf)) return [];

  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  const hits: GrepHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    matcher.lastIndex = 0;
    let m: RegExpExecArray | null;
    let countOnLine = 0;
    while (countOnLine < MAX_MATCHES_PER_LINE && (m = matcher.exec(line)) !== null) {
      if (m[0].length > 0) {
        hits.push({ file_path: filePath, line_number: i + 1, line_content: line.slice(0, 400), matched_text: m[0].toLowerCase() });
        countOnLine++;
      }
      // Zero-length match guard (see doc comment) — applies whether or not this iteration
      // recorded a hit, since `lastIndex` can stall on an empty match either way.
      if (matcher.lastIndex === m.index) matcher.lastIndex++;
    }
  }
  return hits;
}

/**
 * Greps every configured repo root (or, when `opts.scopePath` is given, just that one folder or
 * file) for `pattern` — a real regex, used as-is. Returns raw hits plus whether the deadline
 * forced an early, partial stop. Ranking is a separate pure step (`rankGrepHits`).
 *
 * Invalid regex throws `Invalid regex pattern: <message>` immediately (same shape as the
 * precedent already established by `DevMindDatabase.searchCode`) rather than surfacing as an
 * opaque failure deeper in the walk.
 */
export async function grepRepos(
  repoRoots: string[],
  pattern: string,
  opts: { ignoredPaths?: string[]; timeoutMs?: number; caseInsensitive?: boolean; scopePath?: string } = {}
): Promise<GrepResult> {
  const trimmedPattern = pattern.trim();
  const hasRoots = opts.scopePath ? true : repoRoots.filter(Boolean).length > 0;
  if (!trimmedPattern || !hasRoots) {
    return { hits: [], truncated: false, files_scanned: 0 };
  }
  const extraIgnored = opts.ignoredPaths ?? [];
  // No default cap — a 3s deadline was silently truncating results on repos that legitimately
  // take longer than that to walk, which read as "grep just didn't find it" with no signal that
  // anything was cut short. Callers that DO want a bound (e.g. a latency-sensitive UI) should
  // pass an explicit timeoutMs; `search_nodes` (the only current caller) intentionally doesn't —
  // deliberate even now that `pattern` is a real regex: an unbounded walk against `node_modules`
  // et al is already impossible (ALWAYS_IGNORED / shouldIgnoreDir below run BEFORE any matching,
  // independent of the pattern), so a slow catastrophic-backtrack pattern still only ever runs
  // against real project source, not the whole disk.
  const timeoutMs = opts.timeoutMs ?? Infinity;
  const deadline = timeMonotonic() + timeoutMs;

  const caseInsensitive = opts.caseInsensitive !== false;
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
  }

  // Scoped to one folder/file → that's the only walk root. The scope itself is checked against
  // the ignore rules here (walk() below only checks CHILDREN it descends into, never the root it
  // starts from) — otherwise a scope path pointing straight AT an ignored dir (or a file inside
  // one) would bypass the ignore list entirely instead of correctly finding nothing.
  //
  // The default file denylist is enforced here too, deliberately: "explicit scoping wins" sounds
  // right but would be inconsistent, since a scope pointing at an ignored DIRECTORY has always
  // correctly found nothing. Making files the exception would mean one function enforced two
  // opposite rules. The confusing part of an empty result is not the emptiness, it's the silence
  // — so `searchNodes` pairs this with a hint saying the path was excluded by default, rather
  // than letting it read as "the pattern isn't in there".
  const walkRoots = opts.scopePath ? [opts.scopePath] : repoRoots.filter(Boolean);

  const allFiles: string[] = [];
  let truncated = false;
  for (const root of walkRoots) {
    if (truncated) break;
    if (opts.scopePath && (shouldIgnorePath(root, extraIgnored) || isDefaultIgnoredFile(root))) continue;
    const result = listFiles(root, extraIgnored, deadline);
    allFiles.push(...result.files);
    if (result.truncated) truncated = true;
  }

  const hits: GrepHit[] = [];
  let scanned = 0;

  // Read+scan — synchronous (see grepFile's doc comment for why), deadline-checked between every
  // file so a pathological repo yields a partial result instead of hanging, same as enumeration
  // above. This is the whole point of the "as fast as grep" goal.
  for (const file of allFiles) {
    if (timeMonotonic() > deadline) {
      truncated = true;
      break;
    }
    const fileHits = grepFile(file, matcher);
    scanned++;
    if (fileHits.length) hits.push(...fileHits);
  }

  return { hits, truncated, files_scanned: scanned };
}

/**
 * Ranks raw hits into a capped, ordered PAGE of files — the anti-firehose gate — plus the TRUE
 * total file count before that cap, so a caller can tell "that's everything" from "more exists,
 * ask for the next page" instead of guessing from a bare capped list. Unranked hits across 8
 * repos can be hundreds; dumping them recreates the exact "15-20 low-confidence results I have to
 * eyeball-filter" complaint that made the AI distrust the tool. So: group by file, score by match
 * count weighted toward RARER matched strings (IDF-shaped, same instinct as BM25), reward files
 * matching MULTIPLE distinct strings, sort with a stable tiebreaker, and page.
 */
export function rankGrepHits(
  hits: GrepHit[],
  opts: { maxFiles?: number; maxSampleLines?: number; offset?: number } = {}
): RankGrepHitsResult {
  const maxFiles = opts.maxFiles ?? 25;
  const maxSampleLines = opts.maxSampleLines ?? 5;
  const offset = opts.offset ?? 0;
  if (hits.length === 0) return { files: [], total: 0 };

  // Document frequency per matched string: in how many distinct files does each one appear? A
  // string in few files is a stronger signal than one that's everywhere — the rarity weight below.
  const filesPerText = new Map<string, Set<string>>();
  for (const h of hits) {
    let set = filesPerText.get(h.matched_text);
    if (!set) { set = new Set(); filesPerText.set(h.matched_text, set); }
    set.add(h.file_path);
  }
  const totalFiles = new Set(hits.map(h => h.file_path)).size;
  const rarity = (text: string): number => {
    const df = filesPerText.get(text)?.size ?? 1;
    // log-shaped IDF: rarer ⇒ higher, but never below a small floor so a common string still counts.
    return Math.max(Math.log(1 + totalFiles / df), 0.3);
  };

  interface Acc { total: number; counts: Record<string, number>; lines: { line_number: number; line_content: string }[]; }
  const byFile = new Map<string, Acc>();
  for (const h of hits) {
    let acc = byFile.get(h.file_path);
    if (!acc) { acc = { total: 0, counts: {}, lines: [] }; byFile.set(h.file_path, acc); }
    acc.total++;
    acc.counts[h.matched_text] = (acc.counts[h.matched_text] || 0) + 1;
    if (acc.lines.length < maxSampleLines) acc.lines.push({ line_number: h.line_number, line_content: h.line_content });
  }

  const ranked: RankedFile[] = Array.from(byFile.entries()).map(([file_path, acc]) => {
    const distinct = Object.keys(acc.counts).length;
    // Base: sum over matched strings of (saturating count × that string's rarity). The
    // saturating `1 + log(count)` stops 50 hits of one string from running away, and rarer
    // strings weigh more. Then multiply by `distinct` — the number of DISTINCT matched strings
    // this file contains — because coverage beats frequency: a file matching two different parts
    // of the pattern is almost always more relevant than one matching a single part many times.
    // Rarity still differentiates within a coverage level, so a single hit of an ultra-rare
    // string can still outrank two hits of two common ones.
    let base = 0;
    for (const [text, count] of Object.entries(acc.counts)) {
      const tf = 1 + Math.log(count);
      base += tf * rarity(text);
    }
    const score = base * distinct;
    return {
      file_path,
      total_matches: acc.total,
      match_counts: acc.counts,
      distinct_matches: distinct,
      score,
      sample_lines: acc.lines
    };
  });

  // Stable final tiebreaker (file_path) — without one, equal-scoring files have no guaranteed
  // order, so paginating with offset/limit could repeat or skip rows across calls whenever the
  // sort happens to land them differently.
  ranked.sort((a, b) =>
    b.score - a.score ||
    b.distinct_matches - a.distinct_matches ||
    b.total_matches - a.total_matches ||
    a.file_path.localeCompare(b.file_path)
  );
  return { files: ranked.slice(offset, offset + maxFiles), total: ranked.length };
}

/**
 * A monotonic millisecond clock. `Date.now()` is banned in some execution contexts here and can
 * jump backwards on a clock adjustment; `process.hrtime` is monotonic and always available in Node.
 */
function timeMonotonic(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}
