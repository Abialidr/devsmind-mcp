/**
 * Chat section — a read-only history of `commit_changes` messages, grouped into the sessions
 * `start_session` created. No input box: this shows what the AI already did, chat-bubble style,
 * not a place to talk to it. Relies on view.js for fetchJSON/escapeHtml/renderDiffBlock/withPath/
 * openFullFilePanel.
 *
 * Revert works at three granularities, all backed by the same exact-match safety guard:
 *   - whole message  (/api/message-revert, /api/message-unrevert)
 *   - one file within a message  (/api/message-file-revert, /api/message-file-unrevert)
 *   - one single edit  (/api/message-edit-revert, /api/message-edit-unrevert)
 *
 * A file that took more than one edit in a message shows its INDIVIDUAL changes by default —
 * that's the granularity revert/un-revert act on, so it's what should be in front of the user.
 * The combined, hunk-collapsed view of the whole file's diff is one click away behind "Show
 * combined file diff" for whoever wants the PR-style single-glance version instead.
 */

let chatSessions = [];
let chatDeveloper = null;
let currentSessionId = null;
const savedChatRange = loadLocal('chat-date-range', null);
let chatDateFrom = savedChatRange ? savedChatRange.from : todayKey();
let chatDateTo = savedChatRange ? savedChatRange.to : todayKey();

function saveChatRange() {
  saveLocal('chat-date-range', { from: chatDateFrom, to: chatDateTo });
}

/** Which quick chip (if any) the current from/to values match — null if it's a custom range. */
function chatQuickChipFor(from, to) {
  if (!from && !to) return 'clear';
  const today = todayKey();
  if (from === today && to === today) return 'today';
  if (from === addDaysKey(today, -7) && to === today) return '7d';
  if (from === addDaysKey(today, -30) && to === today) return '30d';
  return null;
}

function initChat() {
  document.getElementById('chat-filter-toggle').addEventListener('click', () => toggleFilterPanel('chat-filter-panel'));

  const fromEl = document.getElementById('chat-date-from');
  const toEl = document.getElementById('chat-date-to');
  fromEl.value = chatDateFrom || '';
  toEl.value = chatDateTo || '';
  fromEl.addEventListener('change', () => { chatDateFrom = fromEl.value || null; saveChatRange(); setActiveChatQuickChip(chatQuickChipFor(chatDateFrom, chatDateTo)); renderSessionList(); });
  toEl.addEventListener('change', () => { chatDateTo = toEl.value || null; saveChatRange(); setActiveChatQuickChip(chatQuickChipFor(chatDateFrom, chatDateTo)); renderSessionList(); });

  document.querySelectorAll('[data-chat-quick]').forEach(btn => {
    btn.addEventListener('click', () => {
      const quick = btn.dataset.chatQuick;
      if (quick === 'clear') { chatDateFrom = null; chatDateTo = null; }
      else if (quick === 'today') { chatDateFrom = todayKey(); chatDateTo = todayKey(); }
      else { chatDateFrom = addDaysKey(todayKey(), -(quick === '7d' ? 7 : 30)); chatDateTo = todayKey(); }
      fromEl.value = chatDateFrom || '';
      toEl.value = chatDateTo || '';
      saveChatRange();
      setActiveChatQuickChip(quick);
      renderSessionList();
    });
  });
  setActiveChatQuickChip(chatQuickChipFor(chatDateFrom, chatDateTo));

  loadActivity();
}
registerTab('chat', initChat);

function setActiveChatQuickChip(quick) {
  document.querySelectorAll('[data-chat-quick]').forEach(b => b.classList.toggle('active', b.dataset.chatQuick === quick));
}

async function loadActivity() {
  const listEl = document.getElementById('session-list');
  listEl.innerHTML = '<div class="empty-hint">Loading…</div>';
  try {
    const data = await fetchJSON('/api/activity');
    chatSessions = data.sessions || [];
    chatDeveloper = data.developer;
    document.getElementById('project-name-label').textContent = chatDeveloper ? `— ${chatDeveloper}` : '';
    renderSessionList();
  } catch (err) {
    listEl.innerHTML = `<div class="empty-hint">Failed to load: ${escapeHtml(err.message)}</div>`;
  }
}

function sessionInRange(session, fromKey, toKey) {
  if (!fromKey && !toKey) return true;
  return session.messages.some(m => dateInRange(m.created_at, fromKey, toKey));
}

function sessionLabel(session) {
  if (session.label) return session.label;
  const first = session.messages[0];
  if (!first) return '(empty session)';
  return first.request || first.summary || '(untitled change)';
}

function renderSessionList() {
  const listEl = document.getElementById('session-list');
  const filtered = chatSessions
    .filter(s => sessionInRange(s, chatDateFrom, chatDateTo))
    .slice()
    .sort((a, b) => b.last_active.localeCompare(a.last_active));

  if (!filtered.length) {
    listEl.innerHTML = `<div class="empty-hint">No sessions in this range. Sessions are created by <code>start_session</code> — an AI agent must call DevsMind for one to show up here.</div>`;
    document.getElementById('chat-empty').classList.remove('hidden');
    document.getElementById('transcript').classList.add('hidden');
    return;
  }

  listEl.innerHTML = filtered.map(s => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" data-session="${escapeHtml(s.id)}">
      <div class="session-item-label">${escapeHtml(sessionLabel(s))}</div>
      <div class="session-item-meta">${s.messages.length} message${s.messages.length === 1 ? '' : 's'} · ${formatDate(s.last_active)}</div>
    </div>
  `).join('');

  listEl.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => selectSession(el.dataset.session));
  });

  // Nothing selected yet (or the selection fell out of the filtered set) — default to the newest.
  if (!currentSessionId || !filtered.some(s => s.id === currentSessionId)) {
    selectSession(filtered[0].id);
  }
}

function selectSession(id) {
  currentSessionId = id;
  document.querySelectorAll('.session-item').forEach(el => el.classList.toggle('active', el.dataset.session === id));
  const session = chatSessions.find(s => s.id === id);
  document.getElementById('chat-empty').classList.add('hidden');
  const transcriptEl = document.getElementById('transcript');
  transcriptEl.classList.remove('hidden');
  if (!session) { transcriptEl.innerHTML = ''; return; }
  transcriptEl.innerHTML = session.messages.map(renderMessagePair).join('');
  transcriptEl.querySelectorAll('.bubble-ai').forEach(el => {
    el.addEventListener('click', () => toggleMessageDiff(el.dataset.message));
  });
  transcriptEl.querySelectorAll('[data-action="revert"]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); doRevert(el.dataset.message); });
  });
  transcriptEl.querySelectorAll('[data-action="unrevert"]').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); doUnrevert(el.dataset.message); });
  });
}

function renderMessagePair(m) {
  const fullyReverted = m.status === 'reverted';
  const partial = m.status === 'partial';
  const requestText = m.request || '(no request text captured)';
  let action = '';
  if (fullyReverted || partial) {
    action = m.can_unrevert
      ? `<button class="btn" data-action="unrevert" data-message="${escapeHtml(m.id)}">↩ Un-revert${partial ? ` message (${m.reverted_edit_count})` : ''}</button>`
      : `<span class="bubble-meta">Restore an earlier message first to un-revert this one</span>`;
    if (!fullyReverted) {
      action += ` <button class="btn danger" data-action="revert" data-message="${escapeHtml(m.id)}">⎌ Revert rest${m.later_applied_count ? ` (+${m.later_applied_count} after)` : ''}</button>`;
    }
  } else {
    action = `<button class="btn danger" data-action="revert" data-message="${escapeHtml(m.id)}">⎌ Revert${m.later_applied_count ? ` (+${m.later_applied_count} after)` : ''}</button>`;
  }

  const statusLabel = fullyReverted ? 'reverted' : partial ? `partially reverted (${m.reverted_edit_count}/${m.edit_count})` : 'applied';

  return `
    <div class="msg-pair ${fullyReverted ? 'reverted' : ''} ${partial ? 'partial' : ''}" data-message-pair="${escapeHtml(m.id)}">
      <div class="bubble bubble-user">${escapeHtml(requestText)}</div>
      <div class="bubble-meta">${formatDate(m.created_at)}</div>
      <div class="bubble bubble-ai" data-message="${escapeHtml(m.id)}">
        ${escapeHtml(m.summary || '(no summary)')}
        <div class="bubble-meta">${m.edit_count} change${m.edit_count === 1 ? '' : 's'} · ${statusLabel} · click to see diff</div>
      </div>
      <div class="msg-actions">${action}</div>
      <div class="file-diff-container hidden" id="diff-${escapeHtml(m.id)}"></div>
    </div>
  `;
}

async function toggleMessageDiff(messageId) {
  const container = document.getElementById(`diff-${messageId}`);
  if (!container) return;
  if (!container.classList.contains('hidden')) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  if (container.dataset.loaded) return;
  await loadMessageDiffInto(container, messageId);
}

/** Fetches + renders one message's per-file diff blocks, wiring up every button inside them. */
async function loadMessageDiffInto(container, messageId) {
  container.innerHTML = '<div class="empty-hint">Loading diff…</div>';
  try {
    const data = await fetchJSON(`/api/message-file-diff?message_id=${encodeURIComponent(messageId)}`);
    container.dataset.loaded = '1';
    container.innerHTML = data.files.map((f, idx) => renderFileDiffBlock(f, idx, messageId)).join('');

    container.querySelectorAll('[data-file-toggle]').forEach(head => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('.file-diff-actions')) return;
        e.stopPropagation();
        const body = container.querySelector(`#${CSS.escape(head.dataset.fileToggle)}`);
        if (!body) return;
        const collapsed = body.classList.toggle('hidden');
        head.classList.toggle('expanded', !collapsed);
      });
    });
    container.querySelectorAll('[data-open-full]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFullFilePanel(btn.dataset.openFull, JSON.parse(btn.dataset.fullHunks));
      });
    });
    container.querySelectorAll('[data-toggle-edits]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const list = container.querySelector(`[data-edits-list="${btn.dataset.toggleEdits}"]`);
        list.classList.toggle('hidden');
        btn.textContent = list.classList.contains('hidden')
          ? btn.dataset.labelClosed
          : btn.dataset.labelOpen;
      });
    });
    container.querySelectorAll('[data-file-revert]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); doFileRevert(messageId, btn.dataset.fileRevert); });
    });
    container.querySelectorAll('[data-file-unrevert]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); doFileUnrevert(messageId, btn.dataset.fileUnrevert); });
    });
    container.querySelectorAll('[data-edit-revert]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); doEditRevert(messageId, btn.dataset.editRevert); });
    });
    container.querySelectorAll('[data-edit-unrevert]').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); doEditUnrevert(messageId, btn.dataset.editUnrevert); });
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">Failed to load diff: ${escapeHtml(err.message)}</div>`;
  }
}

function renderFileDiffBlock(file, idx, messageId) {
  const blockId = `${messageId}-${idx}`;
  const bodyId = `${blockId}-body`;

  if (file.drifted) {
    const body = `
      <div class="drift-note">⚠ ${escapeHtml(file.drift_reason || 'file changed since — showing per-change diffs')}</div>
      ${(file.per_node || []).map(n => `
        <div class="file-diff-head"><span class="path">${escapeHtml(n.node_id)}</span></div>
        ${renderDiffBlock(n.lines)}
      `).join('')}
    `;
    return `
      <div class="file-diff-block">
        <div class="file-diff-head file-collapse-toggle" data-file-toggle="${bodyId}">
          <span class="collapse-chevron">▸</span>
          <span class="path">${escapeHtml(file.file_path)}</span>
        </div>
        <div class="file-diff-body hidden" id="${bodyId}">${body}</div>
      </div>
    `;
  }

  const edits = file.edits || [];
  const appliedCount = edits.filter(e => !e.reverted).length;
  const revertedCount = edits.filter(e => e.reverted).length;
  const fileActions = [
    appliedCount > 0 ? `<button class="btn danger small" data-file-revert="${escapeHtml(file.file_path)}">⎌ Revert this file (${appliedCount})</button>` : '',
    revertedCount > 0 ? `<button class="btn small" data-file-unrevert="${escapeHtml(file.file_path)}">↩ Un-revert this file (${revertedCount})</button>` : ''
  ].filter(Boolean).join(' ');

  const head = `
    <div class="file-diff-head file-collapse-toggle" data-file-toggle="${bodyId}">
      <span class="collapse-chevron">▸</span>
      <span class="path">${escapeHtml(file.file_path)}</span>
      <span class="file-diff-meta">${edits.length ? `${edits.length} change${edits.length === 1 ? '' : 's'}` : ''}</span>
      <span class="file-diff-actions">
        ${fileActions}
        <button class="btn-icon small" data-open-full="${escapeHtml(file.file_path)}" data-full-hunks='${escapeHtml(JSON.stringify(file.full_hunks))}'>📄 View full file</button>
      </span>
    </div>
  `;

  // One edit -> the individual and combined views are identical, so just show the one diff.
  if (edits.length <= 1) {
    return `<div class="file-diff-block">${head}<div class="file-diff-body hidden" id="${bodyId}">${renderDiffBlock(file.hunks, { id: `${blockId}-only` })}</div></div>`;
  }

  // More than one edit -> default to the INDIVIDUAL changes (that's the granularity revert/
  // un-revert act on); the combined, hunk-collapsed file view is a click away behind a toggle.
  const editRows = edits.map(e => `
    <div class="single-edit-row">
      <div class="single-edit-meta">
        <span class="mono">${escapeHtml(e.node_id)}</span>
        <span class="bubble-meta">${formatDate(e.at)} · ${e.reverted ? 'reverted' : 'applied'}</span>
        ${e.reverted
          ? `<button class="btn-icon small" data-edit-unrevert="${escapeHtml(e.id)}">↩ Un-revert this change</button>`
          : `<button class="btn-icon small" data-edit-revert="${escapeHtml(e.id)}">⎌ Revert this change</button>`}
      </div>
      ${renderDiffBlock(e.lines, { id: `${blockId}-edit-${escapeHtml(e.id)}` })}
    </div>
  `).join('');

  const combinedId = `${blockId}-combined`;
  const body = `
    <div class="single-edits-list">${editRows}</div>
    <button class="btn-icon small link-btn" data-toggle-edits="${combinedId}" data-label-closed="▸ Show combined file diff (${edits.length} changes)" data-label-open="▾ Hide combined file diff">▸ Show combined file diff (${edits.length} changes)</button>
    <div class="hidden combined-file-diff" data-edits-list="${combinedId}">${renderDiffBlock(file.hunks, { id: `${combinedId}-block` })}</div>
  `;
  return `
    <div class="file-diff-block">
      ${head}
      <div class="file-diff-body hidden" id="${bodyId}">${body}</div>
    </div>
  `;
}

async function postWithToken(url, body) {
  const res = await fetch(withPath(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Devsmind-Token': DEVSMIND_TOKEN },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** After any revert/un-revert action: refresh the transcript (status/buttons) and reload the
 * diff panel for the message just acted on, so the user doesn't lose their place. */
async function refreshChatAfterAction(messageId) {
  const data = await fetchJSON('/api/activity');
  chatSessions = data.sessions || [];
  if (currentSessionId) selectSession(currentSessionId);
  const container = document.getElementById(`diff-${messageId}`);
  if (container) {
    container.classList.remove('hidden');
    delete container.dataset.loaded;
    await loadMessageDiffInto(container, messageId);
  }
}

async function doRevert(messageId) {
  if (!confirm('Revert this message? This restores the code to before it, and reverts any later messages built on top of it too.')) return;
  const r = await postWithToken('/api/message-revert', { message_id: messageId });
  if (!r.data.ok && !r.ok) { alert(`Revert failed: ${r.data.blocked_at ? r.data.blocked_at.reason : r.data.error || 'unknown error'}`); }
  await loadActivity();
}

async function doUnrevert(messageId) {
  const r = await postWithToken('/api/message-unrevert', { message_id: messageId });
  if (!r.ok) { alert(`Un-revert failed: ${r.data.error || 'unknown error'}`); }
  await loadActivity();
}

async function doFileRevert(messageId, filePath) {
  if (!confirm(`Revert every change this message made to ${filePath}? The rest of this message stays applied.`)) return;
  const r = await postWithToken('/api/message-file-revert', { message_id: messageId, file_path: filePath });
  if (!r.ok) { alert(`Revert failed: ${r.data.error || 'unknown error'}`); }
  await refreshChatAfterAction(messageId);
}

async function doFileUnrevert(messageId, filePath) {
  const r = await postWithToken('/api/message-file-unrevert', { message_id: messageId, file_path: filePath });
  if (!r.ok) { alert(`Un-revert failed: ${r.data.error || 'unknown error'}`); }
  await refreshChatAfterAction(messageId);
}

async function doEditRevert(messageId, editId) {
  if (!confirm('Revert just this one change?')) return;
  const r = await postWithToken('/api/message-edit-revert', { message_id: messageId, edit_id: editId });
  if (!r.ok) { alert(`Revert failed: ${r.data.error || 'unknown error'}`); }
  await refreshChatAfterAction(messageId);
}

async function doEditUnrevert(messageId, editId) {
  const r = await postWithToken('/api/message-edit-unrevert', { message_id: messageId, edit_id: editId });
  if (!r.ok) { alert(`Un-revert failed: ${r.data.error || 'unknown error'}`); }
  await refreshChatAfterAction(messageId);
}
