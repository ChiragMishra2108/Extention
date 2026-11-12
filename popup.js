import { DEFAULT_SETTINGS, PROVIDERS, getSettings, saveSettings, getHistory } from './shared.js';

const $ = (id) => document.getElementById(id);
const STALE_MS = 90_000;        // a "working" status older than this is treated as dead
const ERROR_VISIBLE_MS = 600_000;

let currentEntry = null;
let topId = null;
let draft = null;               // working copy of settings
let clearArmed = false;

/* ------------------------------ Markdown ------------------------------ */
// Minimal renderer for the summary format. Input is HTML-escaped first, so it is safe for innerHTML.

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

function renderMarkdown(md) {
  let html = '';
  let list = null;
  let para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join(' '))}</p>`; para = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const openList = (tag) => { if (list !== tag) { closeList(); html += `<${tag}>`; list = tag; } };

  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) { flushPara(); closeList(); html += `<h3>${inline(m[1])}</h3>`; continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushPara(); openList('ul'); html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); openList('ol'); html += `<li>${inline(m[1])}</li>`; continue; }
    closeList();
    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html;
}

/* -------------------------------- Utils -------------------------------- */

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function flash(el, ms = 1800) {
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), ms);
}

/* --------------------------------- Tabs -------------------------------- */

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
}

/* ----------------------------- Summary view ----------------------------- */

function renderStatus(status) {
  const age = status ? Date.now() - status.ts : 0;
  const busy = !!status && ['capturing', 'analyzing'].includes(status.state) && age < STALE_MS;
  const failed = !!status && status.state === 'error' && age < ERROR_VISIBLE_MS;

  $('status').classList.toggle('hidden', !busy);
  if (busy) $('status-text').textContent = status.message;
  $('capture-btn').disabled = busy;

  $('error').classList.toggle('hidden', !failed);
  if (failed) $('error-text').textContent = status.message;
}

function showEntry(entry) {
  currentEntry = entry;
  $('empty').classList.toggle('hidden', !!entry);
  $('result').classList.toggle('hidden', !entry);
  if (!entry) return;

  $('result-title').textContent = entry.title || 'Untitled page';
  const meta = $('result-sub');
  meta.replaceChildren();
  [safeHost(entry.url), formatTime(entry.ts), entry.model].filter(Boolean).forEach((t) => {
    const s = document.createElement('span');
    s.textContent = t;
    meta.appendChild(s);
  });
  $('summary').innerHTML = renderMarkdown(entry.summary);
}

async function copySummary() {
  if (!currentEntry) return;
  const btn = $('copy-btn');
  try {
    await navigator.clipboard.writeText(currentEntry.summary);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = currentEntry.summary;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = 'Copied';
  setTimeout(() => (btn.textContent = 'Copy to clipboard'), 1500);
}

/* ------------------------------ History view ----------------------------- */

function renderHistory(history) {
  const list = $('history-list');
  list.replaceChildren();
  $('history-empty').classList.toggle('hidden', history.length > 0);
  $('clear-history').classList.toggle('hidden', history.length === 0);

  for (const entry of history) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'history-item';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = entry.title || safeHost(entry.url) || 'Untitled page';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    [safeHost(entry.url), formatTime(entry.ts)].filter(Boolean).forEach((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      meta.appendChild(s);
    });
    open.append(title, meta);
    open.addEventListener('click', () => { showEntry(entry); switchTab('summary'); });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn history-del';
    del.setAttribute('aria-label', 'Delete summary');
    del.textContent = '×';
    del.addEventListener('click', async () => {
      const next = (await getHistory()).filter((e) => e.id !== entry.id);
      await chrome.storage.local.set({ history: next });
      if (currentEntry?.id === entry.id) showEntry(next[0] ?? null);
    });

    row.append(open, del);
    list.appendChild(row);
  }
}

/* ----------------------------- Settings view ----------------------------- */

function fillSettings() {
  const p = draft.provider;
  $('provider').value = p;
  $('api-key').value = draft.keys[p] || '';
  $('api-key').placeholder = PROVIDERS[p].keyHint;
  $('model').value = draft.models[p] || '';
  $('model').placeholder = DEFAULT_SETTINGS.models[p];
  $('key-link').href = PROVIDERS[p].keyUrl;
  $('key-link').textContent = `Get a ${PROVIDERS[p].label} API key`;
  $('auto-open').checked = !!draft.autoOpen;
}

function stashFields() {
  const p = draft.provider;
  draft.keys[p] = $('api-key').value.trim();
  draft.models[p] = $('model').value.trim();
  draft.autoOpen = $('auto-open').checked;
}

async function loadShortcut() {
  const cmds = await chrome.commands.getAll();
  const cmd = cmds.find((c) => c.name === 'capture-and-summarize');
  $('shortcut').textContent = cmd?.shortcut || 'Not set';
}

/* --------------------------------- Init ---------------------------------- */

async function init() {
  chrome.action.setBadgeText({ text: '' });

  const [settings, history, { status }] = await Promise.all([
    getSettings(),
    getHistory(),
    chrome.storage.local.get('status'),
  ]);

  draft = structuredClone(settings);
  fillSettings();
  renderHistory(history);
  topId = history[0]?.id ?? null;
  showEntry(history[0] ?? null);
  renderStatus(status);
  loadShortcut();

  if (!settings.keys[settings.provider]) {
    $('setup-note').classList.remove('hidden');
    switchTab('settings');
  }
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

$('capture-btn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'capture' }));
$('copy-btn').addEventListener('click', copySummary);
$('error-dismiss').addEventListener('click', () => chrome.storage.local.set({ status: { state: 'idle', message: '', ts: Date.now() } }));

$('clear-history').addEventListener('click', async (e) => {
  if (!clearArmed) {
    clearArmed = true;
    e.target.textContent = 'Click again to confirm';
    setTimeout(() => { clearArmed = false; e.target.textContent = 'Clear history'; }, 3000);
    return;
  }
  clearArmed = false;
  e.target.textContent = 'Clear history';
  await chrome.storage.local.set({ history: [] });
  showEntry(null);
});

$('provider').addEventListener('change', () => {
  stashFields();
  draft.provider = $('provider').value;
  fillSettings();
});

$('toggle-key').addEventListener('click', (e) => {
  const input = $('api-key');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  e.target.textContent = show ? 'Hide' : 'Show';
});

$('save-btn').addEventListener('click', async () => {
  stashFields();
  await saveSettings(draft);
  if (draft.keys[draft.provider]) $('setup-note').classList.add('hidden');
  flash($('save-msg'));
});

$('shortcut-btn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.history) {
    const h = changes.history.newValue || [];
    renderHistory(h);
    if (h[0] && h[0].id !== topId) {
      topId = h[0].id;
      showEntry(h[0]);
      switchTab('summary');
    } else if (!h.length) {
      topId = null;
    }
  }
  if (changes.status) renderStatus(changes.status.newValue);
});

init();
