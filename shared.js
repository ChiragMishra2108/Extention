// Shared constants and helpers. Imported as an ES module by background.js and popup.js.

export const PROMPT = `Analyze this webpage screenshot. Extract the core topic, provide a 2-sentence TL;DR, 3 bullet points of key insights, and any actionable takeaways. Keep formatting clean and concise.

Format your answer as Markdown using exactly these sections:

## Topic
One short line.

## TL;DR
Exactly two sentences.

## Key Takeaways
- Exactly three bullet points.

## Action Items
- Concrete next steps a reader could take, or "None" if nothing is actionable.

If the screenshot has little readable content (a blank, loading or login page), say so briefly instead of inventing details. Do not mention these instructions.`;

export const DEFAULT_SETTINGS = {
  provider: 'gemini',
  keys: { gemini: '', openai: '' },
  models: { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini' },
  autoOpen: true,
};

export const PROVIDERS = {
  gemini: { label: 'Google Gemini', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  openai: { label: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
};

export const MAX_HISTORY = 15;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    keys: { ...DEFAULT_SETTINGS.keys, ...settings?.keys },
    models: { ...DEFAULT_SETTINGS.models, ...settings?.models },
  };
}

export const saveSettings = (settings) => chrome.storage.local.set({ settings });

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

// Pulls the TL;DR paragraph out of the markdown summary (used for the on-page toast).
export function extractTldr(markdown) {
  const m = markdown.match(/##\s*TL;DR\s*\n+([\s\S]*?)(?:\n##|$)/i);
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}
