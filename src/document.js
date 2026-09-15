import DOMPurify from 'dompurify';

const parser = new DOMParser();

// Source is canonical. Parsing is exclusively for the isolated editing surface;
// a view change never serializes over the user's original HTML.
export function inspectSource(source) {
  const doc = parser.parseFromString(source, 'text/html');
  const fullDocument = /<!doctype\b|<html\b|<head\b|<body\b/i.test(source);
  const body = DOMPurify.sanitize(doc.body.innerHTML, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link', 'style'],
    FORBID_ATTR: ['srcdoc', 'autofocus'],
    ADD_ATTR: ['target'],
  });
  // CSS stays in the editor iframe; its CSP forbids external CSS requests.
  const css = [...doc.querySelectorAll('style')].map(style => style.textContent).join('\n');
  const attributes = element => Object.fromEntries(['class', 'id', 'style', 'dir', 'lang'].filter(name => element.hasAttribute(name)).map(name => [name, element.getAttribute(name)]));
  return { body, css, fullDocument, bodyAttributes: attributes(doc.body), rootAttributes: attributes(doc.documentElement) };
}

export function replaceBody(source, body) {
  if (!/<!doctype\b|<html\b|<head\b|<body\b/i.test(source)) return body;
  const match = /(<body\b[^>]*>)([\s\S]*?)(<\/body\s*>)/i.exec(source);
  if (match) return source.slice(0, match.index) + match[1] + body + match[3] + source.slice(match.index + match[0].length);
  const doc = parser.parseFromString(source, 'text/html');
  doc.body.innerHTML = body;
  const doctype = source.match(/<!doctype[^>]*>/i)?.[0] ?? '';
  return `${doctype}${doctype ? '\n' : ''}${doc.documentElement.outerHTML}`;
}

export function countWords(source) {
  const doc = parser.parseFromString(source, 'text/html');
  doc.querySelectorAll('style, script, template').forEach(node => node.remove());
  return doc.body.textContent.trim().match(/\S+/gu)?.length ?? 0;
}

export function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const DEFAULT_SETTINGS = Object.freeze({ toolbar: false, split: false, files: false, count: false, lines: false, remember: true });

export function readSettings(storage) {
  try {
    const parsed = JSON.parse(storage.getItem('openwysiwyg.settings') || '{}');
    return Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([key, value]) => [key, typeof parsed?.[key] === 'boolean' ? parsed[key] : value]));
  } catch { return { ...DEFAULT_SETTINGS }; }
}
