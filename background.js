// Service worker: listens for the shortcut, captures the tab, calls the vision model.
import { PROMPT, DEFAULT_SETTINGS, MAX_HISTORY, PROVIDERS, getSettings, getHistory, extractTldr } from './shared.js';

const REQUEST_TIMEOUT_MS = 60_000;
let running = false;
let badgeTimer;

class UserError extends Error {}

/* ---------------------------- Entry points ---------------------------- */

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-and-summarize') runPipeline();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'capture') {
    runPipeline();
    sendResponse({ ok: true });
  }
  return false;
});

/* ------------------------------ Pipeline ------------------------------ */

async function runPipeline() {
  if (running) return;
  running = true;
  let tab;
  let settings;

  try {
    settings = await getSettings();
    const provider = settings.provider;
    const apiKey = settings.keys[provider];
    if (!apiKey) throw new UserError(`Add your ${PROVIDERS[provider].label} API key in Settings to get started.`);

    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new UserError('No active tab found.');

    await setStatus('capturing', 'Capturing screenshot…');
    setBadge('…', '#6366f1');

    let dataUrl;
    try {
      // JPEG keeps the upload small and fast; text stays readable at q80.
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
    } catch (err) {
      throw new UserError(friendlyCaptureError(err));
    }

    const model = settings.models[provider] || DEFAULT_SETTINGS.models[provider];
    await setStatus('analyzing', `Analyzing with ${model}…`);
    showToast(tab.id, 'loading', 'Summarizing this page…');

    const summary = await analyze(dataUrl, provider, model, apiKey);

    const entry = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      title: tab.title || '',
      url: tab.url || '',
      provider,
      model,
      summary,
    };
    const history = [entry, ...(await getHistory())].slice(0, MAX_HISTORY);
    await chrome.storage.local.set({ history });
    await setStatus('done', 'Summary ready');

    setBadge('✓', '#22c55e', 5000);
    showToast(tab.id, 'done', extractTldr(summary).slice(0, 220) || 'Summary ready. Open Snap Summary to read it.');
  } catch (err) {
    const message = err instanceof UserError ? err.message : `Something went wrong: ${err?.message || err}`;
    if (!(err instanceof UserError)) console.error('[Snap Summary]', err);
    await setStatus('error', message);
    setBadge('!', '#ef4444', 6000);
    if (tab?.id != null) showToast(tab.id, 'error', message);
  } finally {
    running = false;
    if (settings?.autoOpen) {
      try { await chrome.action.openPopup(); } catch { /* needs Chrome 127+ and a focused window */ }
    }
  }
}

/* ------------------------------ AI calls ------------------------------ */

async function analyze(dataUrl, provider, model, apiKey) {
  const base64 = dataUrl.split(',')[1];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return provider === 'openai'
      ? await callOpenAI(dataUrl, model, apiKey, ctrl.signal)
      : await callGemini(base64, model, apiKey, ctrl.signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw new UserError('The AI request timed out. Try again.');
    if (err instanceof TypeError) throw new UserError('Network error. Check your connection and try again.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(base64, model, apiKey, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType: 'image/jpeg', data: base64 } }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) throw await apiError(res, 'Gemini');

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
    throw new UserError(`Gemini returned no text${reason ? ` (${reason})` : ''}.`);
  }
  return text;
}

async function callOpenAI(dataUrl, model, apiKey, signal) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'auto' } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw await apiError(res, 'OpenAI');

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new UserError('OpenAI returned no text. Try again or pick a different model.');
  return text;
}

async function apiError(res, name) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch { /* non-JSON body */ }

  if (res.status === 400 && /api key/i.test(detail)) return new UserError(`${name} rejected the API key. Check it in Settings.`);
  if (res.status === 401 || res.status === 403) return new UserError(`${name} rejected the API key or this model isn't available to it. Check Settings.`);
  if (res.status === 404) return new UserError(`${name} doesn't recognise that model name. Check the model in Settings.`);
  if (res.status === 429) return new UserError(`${name} rate limit or quota reached. Wait a moment or check your plan.`);
  return new UserError(`${name} error ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
}

/* ------------------------------ Helpers ------------------------------- */

function friendlyCaptureError(err) {
  const msg = String(err?.message || err);
  if (/cannot access|chrome:\/\/|gallery|not in effect|permission|activeTab/i.test(msg)) {
    return "Chrome doesn't allow screenshots of this page (browser pages, the Web Store and some protected pages are blocked). Switch to a regular website and try again.";
  }
  return `Couldn't capture the tab: ${msg}`;
}

function setStatus(state, message) {
  return chrome.storage.local.set({ status: { state, message, ts: Date.now() } });
}

function setBadge(text, color, clearAfterMs) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  if (clearAfterMs) badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), clearAfterMs);
}

// Small on-page toast so the shortcut gives feedback without opening the popup.
// Injected only after the screenshot is taken, so it never appears in the capture.
async function showToast(tabId, kind, text) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: renderToast, args: [kind, text] });
  } catch { /* restricted page or tab navigated away */ }
}

// Runs inside the page. Must be fully self-contained.
function renderToast(kind, text) {
  const ID = '__snap_summary_toast__';
  document.getElementById(ID)?.remove();

  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .box{display:flex;gap:10px;align-items:flex-start;max-width:340px;padding:12px 14px;border-radius:12px;
      background:#0f1420;color:#e8ebf4;border:1px solid #232a3d;box-shadow:0 8px 28px rgba(0,0,0,.35);
      font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer}
    .error{border-color:#7f2a33}
    .dot{flex:none;width:8px;height:8px;margin-top:5px;border-radius:50%;background:#34d399}
    .error .dot{background:#f87171}
    .spin{flex:none;width:14px;height:14px;margin-top:2px;border-radius:50%;border:2px solid #343c57;border-top-color:#8b92ff;animation:r .8s linear infinite}
    @keyframes r{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
  `;

  const box = document.createElement('div');
  box.className = `box ${kind}`;
  const icon = document.createElement('span');
  icon.className = kind === 'loading' ? 'spin' : 'dot';
  const msg = document.createElement('span');
  msg.textContent = text;
  box.append(icon, msg);
  box.addEventListener('click', () => host.remove());

  root.append(style, box);
  document.documentElement.appendChild(host);
  if (kind !== 'loading') setTimeout(() => host.remove(), kind === 'done' ? 8000 : 6000);
}
