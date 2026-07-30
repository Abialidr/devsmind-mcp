/**
 * Graph section — node-first instead of a whole-graph dump. A repo→type accordion drives
 * selection; clicking a node opens a small 1-hop ego-graph (its uses / used-by only), with a
 * "See whole graph (2D)" escape hatch for when you genuinely want the big picture.
 *
 * Relies on view.js for fetchJSON/escapeHtml/renderDiffBlock/withPath/formatDate.
 */

let gNodes = [];
let gConnections = [];
let gHistory = [];
let gNodesById = new Map();
let gHistoryByNode = new Map(); // node_id -> history entries, newest first (matches getAllHistory order)
let gDevelopersOf = new Map();  // node_id -> latest developer name (or null)
let gAllDevelopers = [];
let gAllTypes = [];
let gSelectedTypes = new Set();
let gSelectedDevs = new Set();
const savedGraphRange = loadLocal('graph-date-range', null);
let gDateFrom = savedGraphRange ? savedGraphRange.from : null;
let gDateTo = savedGraphRange ? savedGraphRange.to : null;
let gSelectedNodeId = null;
let gCurrentEgoIs3D = false;
let gGraphInstance = null;
let gWholeGraphInstance = null;

const TYPE_COLORS = {
  function: '#38bdf8', method: '#38bdf8', class: '#a78bfa', interface: '#34d399',
  type_alias: '#34d399', enum: '#fbbf24', variable: '#94a3b8', constant: '#94a3b8',
  module: '#f472b6', namespace: '#f472b6'
};
function colorForType(type) {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = type.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 60%, 62%)`;
}

function saveGraphRange() {
  saveLocal('graph-date-range', { from: gDateFrom, to: gDateTo });
}

/** Which quick chip (if any) the current from/to values match — null if it's a custom range. */
function graphQuickChipFor(from, to) {
  if (!from && !to) return 'clear';
  const today = todayKey();
  if (from === addDaysKey(today, -1) && to === today) return '1d';
  if (from === addDaysKey(today, -7) && to === today) return '7d';
  if (from === addDaysKey(today, -30) && to === today) return '30d';
  return null;
}

function initGraph() {
  document.getElementById('graph-filter-toggle').addEventListener('click', () => toggleFilterPanel('graph-filter-panel'));
  document.getElementById('node-search').addEventListener('input', applyFilters);

  const fromEl = document.getElementById('graph-date-from');
  const toEl = document.getElementById('graph-date-to');
  fromEl.value = gDateFrom || '';
  toEl.value = gDateTo || '';
  fromEl.addEventListener('change', () => { gDateFrom = fromEl.value || null; saveGraphRange(); setActiveGraphQuickChip(graphQuickChipFor(gDateFrom, gDateTo)); applyFilters(); });
  toEl.addEventListener('change', () => { gDateTo = toEl.value || null; saveGraphRange(); setActiveGraphQuickChip(graphQuickChipFor(gDateFrom, gDateTo)); applyFilters(); });
  document.querySelectorAll('[data-graph-quick]').forEach(btn => {
    btn.addEventListener('click', () => {
      const quick = btn.dataset.graphQuick;
      if (quick === 'clear') { gDateFrom = null; gDateTo = null; }
      else { gDateFrom = addDaysKey(todayKey(), -(quick === '1d' ? 1 : quick === '7d' ? 7 : 30)); gDateTo = todayKey(); }
      fromEl.value = gDateFrom || '';
      toEl.value = gDateTo || '';
      saveGraphRange();
      setActiveGraphQuickChip(quick);
      applyFilters();
    });
  });
  setActiveGraphQuickChip(graphQuickChipFor(gDateFrom, gDateTo));

  document.querySelectorAll('[data-select-all]').forEach(btn => {
    btn.addEventListener('click', () => setCheckGroup(btn.dataset.selectAll, true));
  });
  document.querySelectorAll('[data-select-none]').forEach(btn => {
    btn.addEventListener('click', () => setCheckGroup(btn.dataset.selectNone, false));
  });

  document.getElementById('btn-toggle-3d').addEventListener('click', toggleEgoDimension);
  document.getElementById('btn-whole-graph').addEventListener('click', showWholeGraph);
  document.getElementById('btn-close-whole-graph').addEventListener('click', closeWholeGraph);
  document.getElementById('details-close').addEventListener('click', closeDetails);
  loadGraphData();
}
registerTab('graph', initGraph);

function setActiveGraphQuickChip(quick) {
  document.querySelectorAll('[data-graph-quick]').forEach(b => b.classList.toggle('active', b.dataset.graphQuick === quick));
}

/** "All" / "None" buttons for a checkbox filter group — checks/unchecks every box and reapplies. */
function setCheckGroup(groupId, checked) {
  document.querySelectorAll(`#${groupId} input`).forEach(cb => { cb.checked = checked; });
  const values = new Set(checked ? Array.from(document.querySelectorAll(`#${groupId} input`)).map(cb => cb.value) : []);
  if (groupId === 'type-filters') { gSelectedTypes = values; saveLocal('graph-selected-types', Array.from(values)); }
  else if (groupId === 'dev-filters') { gSelectedDevs = values; saveLocal('graph-selected-devs', Array.from(values)); }
  applyFilters();
}

/**
 * Restores a checkbox group's selection from localStorage, intersected with what's actually
 * available right now (a saved type/developer that no longer exists in this graph is dropped
 * rather than left dangling). No saved value at all means "leave the all-selected default alone".
 */
function restoreCheckGroup(storageKey, groupId, allValues, applySelection) {
  const saved = loadLocal(storageKey, null);
  if (saved === null) return;
  const valid = new Set(saved.filter(v => allValues.includes(v)));
  document.querySelectorAll(`#${groupId} input`).forEach(cb => { cb.checked = valid.has(cb.value); });
  applySelection(valid);
}

async function loadGraphData() {
  const accEl = document.getElementById('node-accordion');
  accEl.innerHTML = '<div class="empty-hint">Loading…</div>';
  try {
    const data = await fetchJSON('/api/graph-data');
    gNodes = (data.nodes || []).filter(n => !n.deprecated);
    gConnections = data.connections || [];
    gHistory = data.history || [];
    gNodesById = new Map(gNodes.map(n => [n.id, n]));

    gHistoryByNode = new Map();
    for (const h of gHistory) {
      const arr = gHistoryByNode.get(h.node_id) || [];
      arr.push(h);
      gHistoryByNode.set(h.node_id, arr);
    }

    const devSet = new Set();
    gDevelopersOf = new Map();
    for (const [nodeId, entries] of gHistoryByNode.entries()) {
      for (const h of entries) {
        const dev = developerOf(h);
        if (dev) {
          devSet.add(dev);
          if (!gDevelopersOf.has(nodeId)) gDevelopersOf.set(nodeId, dev); // entries[0] is newest — used for display only, not filtering
        }
      }
    }
    gAllDevelopers = Array.from(devSet).sort();
    gAllTypes = Array.from(new Set(gNodes.map(n => n.type))).sort();
    gSelectedTypes = new Set(gAllTypes);
    gSelectedDevs = new Set(gAllDevelopers);

    document.getElementById('graph-stats').textContent = `${gNodes.length} nodes · ${gConnections.length} connections`;
    renderFilterChecks();
    restoreCheckGroup('graph-selected-types', 'type-filters', gAllTypes, s => { gSelectedTypes = s; });
    restoreCheckGroup('graph-selected-devs', 'dev-filters', gAllDevelopers, s => { gSelectedDevs = s; });
    buildAccordion();
    applyFilters(); // reflect any restored selection immediately, not just after the next change
  } catch (err) {
    accEl.innerHTML = `<div class="empty-hint">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFilterChecks() {
  document.getElementById('type-filters').innerHTML = gAllTypes.map(t => `
    <label><input type="checkbox" value="${escapeHtml(t)}" checked> ${escapeHtml(t)}</label>
  `).join('') || '<span class="empty-hint">—</span>';
  document.getElementById('dev-filters').innerHTML = gAllDevelopers.map(d => `
    <label><input type="checkbox" value="${escapeHtml(d)}" checked> ${escapeHtml(d)}</label>
  `).join('') || '<span class="empty-hint">no attributed developers yet</span>';

  document.querySelectorAll('#type-filters input').forEach(cb => cb.addEventListener('change', () => {
    gSelectedTypes = new Set(Array.from(document.querySelectorAll('#type-filters input:checked')).map(c => c.value));
    saveLocal('graph-selected-types', Array.from(gSelectedTypes));
    applyFilters();
  }));
  document.querySelectorAll('#dev-filters input').forEach(cb => cb.addEventListener('change', () => {
    gSelectedDevs = new Set(Array.from(document.querySelectorAll('#dev-filters input:checked')).map(c => c.value));
    saveLocal('graph-selected-devs', Array.from(gSelectedDevs));
    applyFilters();
  }));
}

function repoOf(nodeId) {
  const m = /^\{([^}]+)\}\//.exec(nodeId);
  return m ? m[1] : 'workspace';
}

function buildAccordion() {
  const byRepo = new Map();
  for (const n of gNodes) {
    const repo = repoOf(n.id);
    if (!byRepo.has(repo)) byRepo.set(repo, new Map());
    const byType = byRepo.get(repo);
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type).push(n);
  }

  const repoNames = Array.from(byRepo.keys()).sort();
  const html = repoNames.map(repo => {
    const byType = byRepo.get(repo);
    const typeNames = Array.from(byType.keys()).sort();
    const total = typeNames.reduce((s, t) => s + byType.get(t).length, 0);
    const typesHtml = typeNames.map(type => {
      const nodesOfType = byType.get(type).slice().sort((a, b) => a.name.localeCompare(b.name));
      const itemsHtml = nodesOfType.map(n => `
        <div class="node-item" data-node="${escapeHtml(n.id)}" data-name="${escapeHtml(n.name.toLowerCase())}" title="${escapeHtml(n.id)}">${escapeHtml(n.name)}</div>
      `).join('');
      return `
        <details class="type-group">
          <summary>${escapeHtml(type)} <span class="count">${nodesOfType.length}</span></summary>
          ${itemsHtml}
        </details>
      `;
    }).join('');
    return `
      <details class="repo-group">
        <summary>${escapeHtml(repo)} <span class="count">${total}</span></summary>
        ${typesHtml}
      </details>
    `;
  }).join('');

  document.getElementById('node-accordion').innerHTML = html || '<div class="empty-hint">No nodes indexed yet.</div>';
  document.querySelectorAll('.node-item').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.node));
  });
}

function developerOf(historyEntry) {
  const m = /Developer:\s*(.+)/i.exec(historyEntry.reasoning || '');
  return m ? m[1].trim() : null;
}

/**
 * Developer and date are ANDed against the SAME history entry — "changes by Abialidr on this
 * date" means an edit that is both, not "node's latest edit is by Abialidr" AND separately
 * "node's latest edit is on this date" (those can be two different edits).
 */
function nodePassesDevAndDateFilter(nodeId) {
  const devActive = gSelectedDevs.size !== gAllDevelopers.length;
  const dateActive = !!gDateFrom || !!gDateTo;
  if (!devActive && !dateActive) return true;

  const entries = gHistoryByNode.get(nodeId);
  if (!entries || !entries.length) return false;
  return entries.some(h => {
    const devOk = !devActive || (developerOf(h) && gSelectedDevs.has(developerOf(h)));
    const dateOk = !dateActive || dateInRange(h.updated_at, gDateFrom, gDateTo);
    return devOk && dateOk;
  });
}

function applyFilters() {
  const query = document.getElementById('node-search').value.trim().toLowerCase();
  let anyFilterActive = query.length > 0
    || gSelectedTypes.size !== gAllTypes.length
    || gSelectedDevs.size !== gAllDevelopers.length
    || !!gDateFrom || !!gDateTo;

  document.querySelectorAll('.node-item').forEach(el => {
    const node = gNodesById.get(el.dataset.node);
    if (!node) return;
    const matchesSearch = !query || el.dataset.name.includes(query) || node.id.toLowerCase().includes(query);
    const matchesType = gSelectedTypes.has(node.type);
    const matchesDevAndDate = nodePassesDevAndDateFilter(node.id);
    const visible = matchesSearch && matchesType && matchesDevAndDate;
    el.classList.toggle('filtered-out', !visible);
  });

  document.querySelectorAll('.type-group').forEach(group => {
    const items = Array.from(group.querySelectorAll('.node-item'));
    const visibleCount = items.filter(i => !i.classList.contains('filtered-out')).length;
    const hasVisible = visibleCount > 0;
    group.classList.toggle('filtered-out', !hasVisible);
    group.querySelector(':scope > summary .count').textContent =
      anyFilterActive ? `${visibleCount}/${items.length}` : String(items.length);
    if (anyFilterActive && hasVisible) group.open = true;
  });
  document.querySelectorAll('.repo-group').forEach(group => {
    const items = Array.from(group.querySelectorAll('.node-item'));
    const visibleCount = items.filter(i => !i.classList.contains('filtered-out')).length;
    const hasVisible = visibleCount > 0;
    group.classList.toggle('filtered-out', !hasVisible);
    group.querySelector(':scope > summary .count').textContent =
      anyFilterActive ? `${visibleCount}/${items.length}` : String(items.length);
    if (anyFilterActive && hasVisible) group.open = true;
  });

  if (gWholeGraphInstance) renderWholeGraph();
}

function filteredNodeIds() {
  return new Set(
    Array.from(document.querySelectorAll('.node-item:not(.filtered-out)')).map(el => el.dataset.node)
  );
}

// ── Ego-graph ────────────────────────────────────────────────────────────

function egoDataFor(nodeId) {
  const center = gNodesById.get(nodeId);
  if (!center) return null;
  const uses = gConnections.filter(c => c.source_node_id === nodeId)
    .map(c => gNodesById.get(c.target_node_id)).filter(Boolean);
  const usedBy = gConnections.filter(c => c.target_node_id === nodeId)
    .map(c => gNodesById.get(c.source_node_id)).filter(Boolean);

  const nodeMap = new Map();
  nodeMap.set(center.id, { id: center.id, name: center.name, role: 'center' });
  for (const u of uses) if (!nodeMap.has(u.id)) nodeMap.set(u.id, { id: u.id, name: u.name, role: 'uses' });
  for (const u of usedBy) if (!nodeMap.has(u.id)) nodeMap.set(u.id, { id: u.id, name: u.name, role: 'usedby' });

  const links = [
    ...uses.map(u => ({ source: center.id, target: u.id })),
    ...usedBy.map(u => ({ source: u.id, target: center.id }))
  ];
  return { nodes: Array.from(nodeMap.values()), links, uses, usedBy, center };
}

function egoNodeColor(n) {
  return n.role === 'center' ? '#f43f5e' : n.role === 'uses' ? '#38bdf8' : '#a78bfa';
}

// ── Always-on node labels ──────────────────────────────────────────────────
// A bare colored dot with no name is unreadable the moment there's more than one node — every
// node draws its name underneath it, in 2D and 3D, instead of relying on a hover tooltip.

function nodeRadius(n) { return n.role === 'center' ? 7 : 5; }

/** 2D canvas node paint: a dot + its name, sized so text stays legible at any zoom level. */
function paint2DNode(node, ctx, globalScale, colorFn) {
  const r = nodeRadius(node);
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
  ctx.fillStyle = colorFn(node);
  ctx.fill();

  const label = node.name || node.id;
  const fontSize = Math.max(11 / globalScale, 3);
  ctx.font = `${fontSize}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(label, node.x, node.y + r + 1.5);
}

/** Matching hit-area for paint2DNode — covers the dot plus a little of the label below it. */
function paintPointerArea(node, color, ctx) {
  const r = nodeRadius(node);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI, false);
  ctx.fill();
}

/** 3D label: a canvas-drawn dot + name baked into a sprite texture (three.js has no native text). */
function makeNode3DSprite(node, colorFn) {
  const label = node.name || node.id;
  const color = colorFn(node);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 30;
  ctx.font = `${fontSize}px sans-serif`;
  const textWidth = ctx.measureText(label).width;
  canvas.width = textWidth + 34;
  canvas.height = fontSize + 14;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(14, canvas.height / 2, 10, 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = '#e2e8f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 30, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width / 9, canvas.height / 9, 1);
  return sprite;
}

function selectNode(nodeId) {
  const node = gNodesById.get(nodeId);
  if (!node) return;
  gSelectedNodeId = nodeId;
  document.querySelectorAll('.node-item').forEach(el => el.classList.toggle('selected', el.dataset.node === nodeId));

  document.getElementById('graph-empty').classList.add('hidden');
  document.getElementById('ego-legend').classList.remove('hidden');
  document.getElementById('graph-canvas').classList.remove('hidden');

  const ego = egoDataFor(nodeId);
  renderEgoGraph(ego);
  renderDetailsPane(node, ego);
}

function renderEgoGraph(ego) {
  const container = document.getElementById('graph-canvas');
  container.innerHTML = '';
  const width = container.clientWidth || 600, height = container.clientHeight || 500;

  const graphPayload = {
    nodes: ego.nodes.map(n => ({ ...n })),
    links: ego.links.map(l => ({ ...l }))
  };

  if (gCurrentEgoIs3D && window.ForceGraph3D) {
    gGraphInstance = ForceGraph3D()(container)
      .backgroundColor('#0b0f19')
      .width(width).height(height)
      .graphData(graphPayload)
      .nodeLabel(n => n.name)
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .linkColor(() => 'rgba(148,163,184,0.5)')
      .onNodeClick(n => { if (n.id !== gSelectedNodeId) selectNode(n.id); });
    if (window.THREE) {
      gGraphInstance.nodeThreeObject(n => makeNode3DSprite(n, egoNodeColor));
    } else {
      gGraphInstance.nodeColor(egoNodeColor); // THREE missing — fall back to a plain colored sphere
    }
  } else if (window.ForceGraph) {
    gGraphInstance = ForceGraph()(container)
      .width(width).height(height)
      .backgroundColor('#0b0f19')
      .graphData(graphPayload)
      .nodeLabel(n => n.name)
      .nodeCanvasObject((n, ctx, gs) => paint2DNode(n, ctx, gs, egoNodeColor))
      .nodeCanvasObjectMode(() => 'replace')
      .nodePointerAreaPaint(paintPointerArea)
      .linkDirectionalArrowLength(5)
      .linkDirectionalArrowRelPos(1)
      .linkColor(() => 'rgba(148,163,184,0.5)')
      .onNodeClick(n => { if (n.id !== gSelectedNodeId) selectNode(n.id); });
  } else {
    container.innerHTML = '<div class="empty-hint">Graph library failed to load — check /vendor assets.</div>';
  }
}

function toggleEgoDimension() {
  gCurrentEgoIs3D = !gCurrentEgoIs3D;
  document.getElementById('btn-toggle-3d').textContent = gCurrentEgoIs3D ? '📐 2D' : '🌌 3D';
  if (gSelectedNodeId) renderEgoGraph(egoDataFor(gSelectedNodeId));
}

// ── Details pane ─────────────────────────────────────────────────────────

function closeDetails() {
  document.getElementById('details-pane').classList.add('hidden');
}

function renderDetailsPane(node, ego) {
  const pane = document.getElementById('details-pane');
  pane.classList.remove('hidden');
  const history = (gHistoryByNode.get(node.id) || []);

  const connLink = (n, dir) => `<button class="conn-link" data-node="${escapeHtml(n.id)}">${dir === 'in' ? '←' : '→'} ${escapeHtml(n.name)}</button>`;

  document.getElementById('details-content').innerHTML = `
    <span class="detail-type-badge" style="background:${colorForType(node.type)}22;color:${colorForType(node.type)}">${escapeHtml(node.type)}</span>
    <div class="detail-name">${escapeHtml(node.name)}</div>
    <div class="detail-id">${escapeHtml(node.id)}</div>
    <div class="detail-field">
      <div class="detail-field-label">File</div>
      <div class="detail-field-value">${escapeHtml(node.file_path)}</div>
    </div>
    ${node.signature ? `<div class="detail-field"><div class="detail-field-label">Signature</div><div class="detail-field-value">${escapeHtml(node.signature)}</div></div>` : ''}
    <div class="detail-field">
      <div class="detail-field-label">Uses (${ego.uses.length})</div>
      ${ego.uses.length ? ego.uses.map(n => connLink(n, 'out')).join('') : '<span class="empty-hint">none</span>'}
    </div>
    <div class="detail-field">
      <div class="detail-field-label">Used by (${ego.usedBy.length})</div>
      ${ego.usedBy.length ? ego.usedBy.map(n => connLink(n, 'in')).join('') : '<span class="empty-hint">none</span>'}
    </div>
    <div class="detail-field">
      <div class="detail-field-label">History (${history.length})</div>
      ${history.length ? history.map(renderHistoryEntry).join('') : '<span class="empty-hint">no recorded edits yet</span>'}
    </div>
  `;

  document.getElementById('details-content').querySelectorAll('.conn-link').forEach(el => {
    el.addEventListener('click', () => selectNode(el.dataset.node));
  });
  document.getElementById('details-content').querySelectorAll('[data-load-diff]').forEach(el => {
    el.addEventListener('click', () => loadNodeDiff(el.dataset.loadDiff));
  });
}

function renderHistoryEntry(h) {
  const devMatch = /Developer:\s*(.+)/i.exec(h.reasoning || '');
  const whatMatch = /what_changed:\s*(.+)/i.exec(h.reasoning || '');
  return `
    <div class="history-entry">
      <div class="when">${formatDate(h.updated_at)} ${devMatch ? `· <span class="dev-badge">${escapeHtml(devMatch[1].trim())}</span>` : ''}</div>
      ${whatMatch ? `<div>${escapeHtml(whatMatch[1].trim())}</div>` : ''}
      ${h.edit_count > 0
        ? `<button class="btn-icon small" data-load-diff="${escapeHtml(h.id)}">View changes (${h.edit_count})</button><div id="node-diff-${escapeHtml(h.id)}"></div>`
        : ''}
    </div>
  `;
}

async function loadNodeDiff(historyId) {
  const el = document.getElementById(`node-diff-${historyId}`);
  if (!el) return;
  if (el.dataset.loaded) { el.classList.toggle('hidden'); return; }
  el.innerHTML = '<div class="empty-hint">Loading…</div>';
  try {
    const data = await fetchJSON(`/api/node-diff?history_id=${encodeURIComponent(historyId)}`);
    el.dataset.loaded = '1';
    el.innerHTML = data.edits.map(e => `
      ${renderDiffBlock(e.lines)}
      ${e.revertable
        ? `<button class="btn danger" data-revert-history="${escapeHtml(historyId)}">⎌ Revert this change</button>`
        : e.blocked_reason ? `<div class="drift-note">${escapeHtml(e.blocked_reason)}</div>` : ''}
    `).join('');
    const revertBtn = el.querySelector('[data-revert-history]');
    if (revertBtn) revertBtn.addEventListener('click', () => revertNodeEdit(historyId));
  } catch (err) {
    el.innerHTML = `<div class="empty-hint">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

async function revertNodeEdit(historyId) {
  if (!confirm('Revert this change? This restores the code to before it and erases the change from history.')) return;
  const res = await fetch(withPath('/api/revert'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Devsmind-Token': DEVSMIND_TOKEN },
    body: JSON.stringify({ history_id: historyId })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(`Revert failed: ${data.error || 'unknown error'}`); return; }
  await loadGraphData();
  if (gSelectedNodeId) selectNode(gSelectedNodeId);
}

// ── Whole graph (2D only) ────────────────────────────────────────────────

function showWholeGraph() {
  const overlay = document.getElementById('whole-graph-overlay');
  overlay.classList.remove('hidden');
  renderWholeGraph();
}

/** (Re)draws the whole-graph overlay from the current filter state. Called on open and whenever
 * applyFilters() runs while the overlay is open, so filter changes are reflected live. */
function renderWholeGraph() {
  const container = document.getElementById('whole-graph-canvas');
  if (!window.ForceGraph) { container.innerHTML = '<div class="empty-hint">Graph library failed to load.</div>'; return; }

  const ids = filteredNodeIds();
  const nodeSet = gNodes.filter(n => ids.has(n.id));
  const nodeIdSet = new Set(nodeSet.map(n => n.id));
  const links = gConnections.filter(c => nodeIdSet.has(c.source_node_id) && nodeIdSet.has(c.target_node_id))
    .map(c => ({ source: c.source_node_id, target: c.target_node_id }));

  container.innerHTML = '';
  const wholeGraphColor = n => colorForType(n.type);
  gWholeGraphInstance = ForceGraph()(container)
    .width(container.clientWidth || 900).height(container.clientHeight || 600)
    .backgroundColor('#0b0f19')
    .graphData({ nodes: nodeSet.map(n => ({ id: n.id, name: n.name, type: n.type })), links })
    .nodeLabel(n => `${n.name} (${n.type})`)
    .nodeCanvasObject((n, ctx, gs) => paint2DNode(n, ctx, gs, wholeGraphColor))
    .nodeCanvasObjectMode(() => 'replace')
    .nodePointerAreaPaint(paintPointerArea)
    .linkColor(() => 'rgba(148,163,184,0.35)')
    .linkDirectionalArrowLength(3)
    .onNodeClick(n => { closeWholeGraph(); selectNode(n.id); });
}

function closeWholeGraph() {
  document.getElementById('whole-graph-overlay').classList.add('hidden');
  gWholeGraphInstance = null;
}
