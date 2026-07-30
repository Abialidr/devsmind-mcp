/**
 * Shared shell for the DevsMind view app: tab switching, the ?path= param every fetch carries,
 * a fetch helper, HTML escaping, a reusable floating-filter toggle, and the diff-line renderer
 * shared by both view_chat.js (message diffs) and view_graph.js (per-node history diffs).
 *
 * view_chat.js and view_graph.js each register an init function here; the shell calls the
 * relevant one lazily, the first time a tab is opened, so the Graph section's /api/graph-data
 * fetch never happens if the user never opens it.
 */

const urlParams = new URLSearchParams(window.location.search);
const pathParam = urlParams.get('path') || '';

function withPath(url) {
  const sep = url.includes('?') ? '&' : '?';
  return pathParam ? `${url}${sep}path=${encodeURIComponent(pathParam)}` : url;
}

async function fetchJSON(url, opts) {
  const res = await fetch(withPath(url), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso || ''; }
}

function isSameDay(isoA, isoB) {
  const a = new Date(isoA), b = new Date(isoB);
  return a.toDateString() === b.toDateString();
}

/** 'YYYY-MM-DD' in local time — the value a native <input type="date"> expects/produces. */
function dateKeyOf(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey() { return dateKeyOf(new Date()); }

function addDaysKey(key, deltaDays) {
  const d = new Date(`${key}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return dateKeyOf(d);
}

/** True if `iso`'s local date falls within [fromKey, toKey] — either bound may be null (open). */
function dateInRange(iso, fromKey, toKey) {
  const key = dateKeyOf(iso);
  if (fromKey && key < fromKey) return false;
  if (toKey && key > toKey) return false;
  return true;
}

// ── Diff rendering (unified + side-by-side) ────────────────────────────────
// Every diff shown anywhere in the app (file hunks, individual edits, node-history diffs)
// renders through renderDiffBlock. There is exactly ONE toggle for this — the topbar's
// "Side by side" button — which flips every diff currently on the page at once. Per-block
// toggles were tried first and had a real bug: blocks whose id happened to collide (legacy
// edits recorded before each one had its own id) shared one DOM node, so only the first
// block's button actually did anything. A single page-wide control has no ids to collide on.
// The one exception is the full-file side panel, which is permanently locked to side-by-side
// (see openFullFilePanel) and sits outside this page-wide toggle entirely.

let diffViewMode = loadLocal('diff-view-mode', 'unified');
let diffBlockSeq = 0;

/** Red/green/context rows with an old#/new# gutter — top-to-bottom, like `git diff`. */
function renderUnifiedDiff(lines) {
  if (!lines || !lines.length) return '<div class="empty-hint">No changes to show.</div>';
  const marker = { add: '+', del: '-', ctx: '' };
  return `<div class="diff-lines">${lines.map(l => `
    <div class="diff-line ${l.type}">
      <span class="line-no old">${l.old_line ?? ''}</span>
      <span class="line-no new">${l.new_line ?? ''}</span>
      <span class="line-marker">${marker[l.type]}</span>
      <span class="line-text">${escapeHtml(l.text)}</span>
    </div>
  `).join('')}</div>`;
}

/** Before (left) vs after (right), like a PR's split view. Deletion/addition runs that fall
 * in the same change group share a row so they line up; unequal-length runs pad with blanks. */
function renderSideBySideDiff(lines) {
  if (!lines || !lines.length) return '<div class="empty-hint">No changes to show.</div>';
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (l.type === 'ctx') { rows.push([l, l]); i++; continue; }
    const dels = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    const adds = [];
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) rows.push([dels[k] || null, adds[k] || null]);
  }
  const cell = (l, lineNoKey) => l
    ? `<span class="line-no">${l[lineNoKey] ?? ''}</span><span class="line-text">${escapeHtml(l.text)}</span>`
    : `<span class="line-no"></span><span class="line-text"></span>`;
  return `<div class="diff-sxs">${rows.map(([left, right]) => `
    <div class="diff-sxs-row">
      <div class="diff-sxs-cell ${left ? left.type : 'blank'}">${cell(left, 'old_line')}</div>
      <div class="diff-sxs-cell ${right ? right.type : 'blank'}">${cell(right, 'new_line')}</div>
    </div>
  `).join('')}</div>`;
}

function renderDiffByMode(lines, mode) {
  return mode === 'side-by-side' ? renderSideBySideDiff(lines) : renderUnifiedDiff(lines);
}

/** Diff block, no toggle of its own — mode comes from the page-wide `diffViewMode` (or
 * `opts.mode` when `opts.locked` fixes this specific block regardless of the page-wide
 * setting, e.g. the full-file panel). `opts.id` lets a caller address it later. The lines are
 * kept on the block as JSON so the global toggle can re-render it with no refetch. */
function renderDiffBlock(lines, opts) {
  opts = opts || {};
  const id = opts.id || `diffblk-${++diffBlockSeq}`;
  const mode = opts.locked ? (opts.mode || 'side-by-side') : diffViewMode;
  return `<div class="diff-block" id="${id}" data-diff-lines='${escapeHtml(JSON.stringify(lines || []))}' data-diff-mode="${mode}"${opts.locked ? ' data-diff-locked="1"' : ''}>
    <div class="diff-block-body">${renderDiffByMode(lines, mode)}</div>
  </div>`;
}

/** Flips every diff block currently on the page (except locked ones, e.g. the full-file panel)
 * between unified and side-by-side in one shot, and remembers the choice for diffs opened later. */
function setDiffViewMode(mode) {
  diffViewMode = mode;
  saveLocal('diff-view-mode', mode);
  document.querySelectorAll('.diff-block:not([data-diff-locked])').forEach(block => {
    const lines = JSON.parse(block.dataset.diffLines || '[]');
    block.dataset.diffMode = mode;
    block.querySelector('.diff-block-body').innerHTML = renderDiffByMode(lines, mode);
  });
  const btn = document.getElementById('btn-diff-mode');
  if (btn) btn.textContent = mode === 'side-by-side' ? '≡ Unified' : '⇄ Side by side';
}

document.getElementById('btn-diff-mode').textContent = diffViewMode === 'side-by-side' ? '≡ Unified' : '⇄ Side by side';
document.getElementById('btn-diff-mode').addEventListener('click', () => {
  setDiffViewMode(diffViewMode === 'side-by-side' ? 'unified' : 'side-by-side');
});

function toggleFilterPanel(id) {
  document.getElementById(id).classList.toggle('hidden');
}

// ── Full-file side panel ─────────────────────────────────────────────────
// A single shared panel (half the page width) for "view full file" — opened from Chat's
// per-file diff blocks. "Changes only" (the collapsed hunks) stays the inline default; this is
// only ever a deliberate, separate look at the whole reconstructed file. Always side-by-side,
// with no unified toggle — the wide, whole-file split view is the point of opening this panel;
// a unified rendering of an entire file belongs in "changes only", not here. Locked, so it also
// sits outside the page-wide diff-mode toggle.

function openFullFilePanel(filePath, diffLines) {
  document.getElementById('full-file-path').textContent = filePath;
  document.getElementById('full-file-body').innerHTML = renderDiffBlock(diffLines, { id: 'full-file-diff-block', mode: 'side-by-side', locked: true });
  document.getElementById('full-file-backdrop').classList.remove('hidden');
  document.getElementById('full-file-panel').classList.remove('hidden');
}

function closeFullFilePanel() {
  document.getElementById('full-file-backdrop').classList.add('hidden');
  document.getElementById('full-file-panel').classList.add('hidden');
}

document.getElementById('full-file-close').addEventListener('click', closeFullFilePanel);
document.getElementById('full-file-backdrop').addEventListener('click', closeFullFilePanel);

// ── Filter persistence ──────────────────────────────────────────────────────
// Filter selections survive a reload/tab-switch via localStorage, scoped per-brain (?path=) so
// two different projects opened in the same browser don't stomp on each other's saved filters.

function saveLocal(key, value) {
  try { localStorage.setItem(`devsmind:${pathParam}:${key}`, JSON.stringify(value)); } catch { /* private mode, quota, etc — filters just won't persist */ }
}

function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(`devsmind:${pathParam}:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}

// Close an open floating filter panel on an outside click.
document.addEventListener('click', (e) => {
  for (const panel of document.querySelectorAll('.filter-panel:not(.hidden)')) {
    if (!panel.contains(e.target) && !e.target.closest('[id$="-filter-toggle"]')) {
      panel.classList.add('hidden');
    }
  }
});

// ── Tabs ──────────────────────────────────────────────────────────────────

const sections = { chat: document.getElementById('section-chat'), graph: document.getElementById('section-graph') };
const tabs = { chat: document.getElementById('tab-chat'), graph: document.getElementById('tab-graph') };
let activeTab = 'chat';
const tabInitializers = {};
const tabInitialized = { chat: false, graph: false };

/** view_chat.js / view_graph.js register their one-time init here. */
function registerTab(name, initFn) {
  tabInitializers[name] = initFn;
}

function switchTab(name) {
  if (!sections[name]) return;
  activeTab = name;
  for (const key of Object.keys(sections)) {
    sections[key].classList.toggle('hidden', key !== name);
    tabs[key].classList.toggle('active', key === name);
    tabs[key].setAttribute('aria-selected', key === name ? 'true' : 'false');
  }
  if (!tabInitialized[name] && tabInitializers[name]) {
    tabInitialized[name] = true;
    tabInitializers[name]();
  }
}

tabs.chat.addEventListener('click', () => switchTab('chat'));
tabs.graph.addEventListener('click', () => switchTab('graph'));

document.getElementById('btn-reload').addEventListener('click', () => {
  tabInitialized[activeTab] = false;
  switchTab(activeTab);
});

// Kick off the default (Chat) tab once the other two scripts have registered their init fns.
window.addEventListener('DOMContentLoaded', () => switchTab('chat'));
