import tinymce from 'tinymce';
import 'tinymce/icons/default/icons.min.js';
import 'tinymce/themes/silver/theme.min.js';
import 'tinymce/models/dom/model.min.js';
import 'tinymce/plugins/lists';
import 'tinymce/plugins/advlist';
import 'tinymce/plugins/link';
import 'tinymce/plugins/image';
import 'tinymce/plugins/table';
import 'tinymce/plugins/searchreplace';
import 'tinymce/skins/ui/oxide/skin.min.css';
import contentUi from 'tinymce/skins/ui/oxide/content.min.css?inline';
import { EditorView, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { EditorState, Compartment, Annotation } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { DEFAULT_SETTINGS, readSettings, inspectSource, replaceBody, countWords } from './document.js';
import { detectFormat, toHTML, fromHTML } from './formats.js';
import './style.css';
import fragmentStyle from './document.css?inline';

const $ = selector => document.querySelector(selector);
const embedded = new URLSearchParams(location.search).get('embed') === 'workbench';
const workbenchOrigins = new Set(['http://127.0.0.1:4747', 'http://localhost:4747', 'http://[::1]:4747']);
let workbenchOrigin;
if (embedded) {
  document.body.dataset.embed = 'workbench';
  document.body.dataset.theme = 'dark';
  try {
    const origin = new URL(document.referrer).origin;
    if (workbenchOrigins.has(origin)) workbenchOrigin = origin;
  } catch { /* A direct visit has no parent origin. */ }
}
function announceReady() {
  if (embedded && workbenchOrigin && window.parent !== window && document.body.dataset.ready === 'true') {
    window.parent.postMessage({ type: 'openwysiwyg:ready' }, workbenchOrigin);
  }
}
window.addEventListener('message', event => {
  if (!embedded || event.source !== window.parent || !workbenchOrigins.has(event.origin) || event.data?.type !== 'openwysiwyg:connect') return;
  workbenchOrigin = event.origin;
  announceReady();
});
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.tagName, color: '#84c9a2' },
  { tag: [tags.attributeName, tags.propertyName], color: '#a8c7fa' },
  { tag: [tags.string, tags.attributeValue], color: '#e8c48c' },
  { tag: tags.comment, color: '#8b96a5' },
  { tag: [tags.keyword, tags.modifier], color: '#c3a6ef' },
  { tag: [tags.number, tags.bool, tags.null], color: '#efb093' },
  { tag: [tags.angleBracket, tags.punctuation, tags.operator], color: '#b5bfcb' },
  { tag: tags.heading, color: '#a8c7fa', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#84c9a2', textDecoration: 'underline' },
  { tag: tags.monospace, color: '#e8c48c' },
]);
const settings = readSettings({ getItem: key => localStorage.getItem(key) });
let source = '';
let filename = 'document.html';
let formatPreference = 'auto';
let formatHint = '';
let currentFormat = 'html';
let formatRefreshPending = false;
let mode = 'rendered';
let rich;
let syncingRich = false;
let renderedBody = '';
let richSource = null;
let syncTimer;
let noticeTimer;
let saved = true;
let pendingReplacement;
let conflict = false;
let originalFrameAttributes;
const draftKey = 'openwysiwyg.document';
const externalChange = Annotation.define();
const numberGutter = new Compartment();
const sourceLanguage = new Compartment();
const sourceAttributes = new Compartment();
const formatNames = { html: 'HTML', markdown: 'Markdown', text: 'Plain text' };

function notify(message, persistent = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 4200);
}

try {
  if (settings.remember) {
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (draft && (typeof draft.source === 'string' || typeof draft.html === 'string')) {
      source = draft.source ?? draft.html;
      if (typeof draft.name === 'string') filename = draft.name;
      if (['auto', 'html', 'markdown', 'text'].includes(draft.formatPreference)) formatPreference = draft.formatPreference;
      if (typeof draft.formatHint === 'string') formatHint = draft.formatHint;
    }
  }
} catch { notify('This browser cannot restore the saved draft.'); }
currentFormat = formatPreference === 'auto' ? detectFormat(source, formatHint) : formatPreference;

function languageFor(format) { return format === 'markdown' ? markdown({ htmlTagLanguage: html() }) : format === 'html' ? html() : []; }
function editorAttributes() { return { 'aria-label': `${formatNames[currentFormat]} source`, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }; }
function outputHTML() { return toHTML(source, currentFormat); }

function refreshFormat() {
  const next = formatPreference === 'auto' ? detectFormat(source, formatHint) : formatPreference;
  const changedFormat = next !== currentFormat;
  currentFormat = next;
  document.body.dataset.format = currentFormat;
  $('#format-label').textContent = formatPreference === 'auto' && !source.trim() ? 'Auto detect' : `${formatPreference === 'auto' ? 'Detected' : 'Format'}: ${formatNames[currentFormat]}`;
  $('#format-button').title = `${formatNames[currentFormat]} · ${formatPreference === 'auto' ? 'automatically detected' : 'manually selected'} — change input format`;
  $('#format-select').value = formatPreference;
  $('#source-button').textContent = currentFormat === 'text' ? 'Text' : formatNames[currentFormat];
  $('#export-button').hidden = currentFormat === 'html';
  if (changedFormat) {
    richSource = null;
    code.dispatch({ effects: [sourceLanguage.reconfigure(languageFor(currentFormat)), sourceAttributes.reconfigure(EditorView.contentAttributes.of(editorAttributes()))] });
  }
  if (mode === 'export') {
    if (currentFormat === 'html') setMode('html', false);
    else $('#generated-code').textContent = outputHTML();
  }
}

function scheduleFormatRefresh() {
  if (formatRefreshPending) return;
  formatRefreshPending = true;
  queueMicrotask(() => { formatRefreshPending = false; refreshFormat(); updateStatus(); });
}

const code = new EditorView({
  parent: $('#code-editor'),
  state: EditorState.create({
    doc: source,
    extensions: [
      sourceLanguage.of(languageFor(currentFormat)), history(), bracketMatching(), indentOnInput(),
      syntaxHighlighting(embedded ? darkHighlightStyle : defaultHighlightStyle),
      EditorView.theme({}, { dark: embedded }),
      EditorView.lineWrapping,
      numberGutter.of(settings.lines ? lineNumbers() : []),
      placeholder('Paste HTML, Markdown or text…'),
      sourceAttributes.of(EditorView.contentAttributes.of(editorAttributes())),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || update.transactions.every(tr => tr.annotation(externalChange))) return;
        source = update.state.doc.toString();
        if (update.transactions.some(tr => tr.isUserEvent('input.paste'))) formatHint = '';
        scheduleFormatRefresh();
        changed();
        clearTimeout(syncTimer);
        if (mode === 'split') syncTimer = setTimeout(() => renderSource(), 220);
      }),
    ],
  }),
});

function updateCode() {
  if (code.state.doc.toString() === source) return;
  code.dispatch({ changes: { from: 0, to: code.state.doc.length, insert: source }, annotations: externalChange.of(true) });
}

function saveDraft() {
  saved = false;
  if (settings.remember && !conflict) {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ html: source, source, name: filename, formatPreference, formatHint }));
      saved = true;
    } catch { notify('Draft could not be saved. Enable File actions in Settings to download a copy.', true); }
  }
  updateStatus();
}

function changed() { saveDraft(); }

function updateStatus() {
  if (settings.count) {
    const words = countWords(outputHTML());
    $('#word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    $('#save-state').textContent = settings.remember && saved ? 'Saved in this browser' : 'Not saved';
  }
}

function renderSource(resetUndo = false) {
  refreshFormat();
  if (!rich || (richSource === source && !resetUndo)) return;
  const parsed = inspectSource(outputHTML());
  document.body.dataset.documentKind = parsed.fullDocument ? 'full' : 'fragment';
  syncingRich = true;
  rich.setContent(parsed.body);
  const doc = rich.getDoc();
  if (!originalFrameAttributes) originalFrameAttributes = [doc.documentElement, doc.body].map(element => Object.fromEntries(['class', 'id', 'style', 'dir', 'lang'].map(name => [name, element.getAttribute(name)])));
  [parsed.rootAttributes, parsed.bodyAttributes].forEach((attributes, index) => {
    const element = index ? doc.body : doc.documentElement;
    for (const [name, original] of Object.entries(originalFrameAttributes[index])) {
      const value = name === 'class' ? [original, attributes[name]].filter(Boolean).join(' ') : attributes[name] ?? original;
      if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
    }
  });
  let baseStyle = doc.getElementById('document-base-css');
  if (!baseStyle) { baseStyle = doc.createElement('style'); baseStyle.id = 'document-base-css'; doc.head.append(baseStyle); }
  // Full documents use browser defaults and their own CSS; fragment documents
  // get readable editing defaults. Neither stylesheet becomes part of the HTML.
  baseStyle.textContent = parsed.fullDocument
    ? 'html { background: #fff; color-scheme: light; } body { font-family: revert; } table { border-collapse: revert; } .mce-content-body { overflow-wrap: normal; word-wrap: normal; }'
    : fragmentStyle;
  let style = doc.getElementById('document-css');
  if (!style) { style = doc.createElement('style'); style.id = 'document-css'; doc.head.append(style); }
  style.textContent = parsed.css;
  renderedBody = rich.getContent();
  richSource = source;
  // A source change starts a new visual undo baseline; HTML has its own undo.
  rich.undoManager.clear();
  rich.undoManager.add();
  syncingRich = false;
}

function richChanged() {
  if (syncingRich || !rich) return;
  const body = rich.getContent();
  if (body === renderedBody) return;
  renderedBody = body;
  source = currentFormat === 'html' ? replaceBody(source, body) : fromHTML(body, currentFormat);
  richSource = source;
  updateCode();
  changed();
  scheduleFormatRefresh();
}

function setMode(next, focus = true) {
  if (next === 'split' && !settings.split) next = 'rendered';
  if (next === 'export' && currentFormat === 'html') next = 'html';
  clearTimeout(syncTimer);
  // Never read stale rich content after typing in the source pane.
  if (mode === 'rendered') richChanged();
  mode = next;
  if (mode !== 'html' && mode !== 'export') renderSource();
  updateCode();
  document.body.dataset.mode = mode;
  $('#rendered-pane').hidden = mode === 'html' || mode === 'export';
  $('#html-pane').hidden = mode === 'rendered';
  $('#code-editor').hidden = mode === 'export';
  $('#generated-view').hidden = mode !== 'export';
  if (mode === 'export') $('#generated-code').textContent = outputHTML();
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === mode)));
  requestAnimationFrame(() => {
    code.requestMeasure();
    if (focus) { if (mode === 'export') $('#generated-code').focus(); else if (mode === 'html' || (mode === 'split' && settings.splitOrder === 'html-first')) code.focus(); else rich?.focus(); }
  });
}

function shortcut(event) {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    setMode(mode === 'html' || mode === 'export' ? 'rendered' : 'html');
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault();
    download();
  }
}

function applySettings() {
  document.body.dataset.toolbar = settings.toolbar ? 'on' : 'off';
  $('#split-button').hidden = !settings.split;
  $('#split-order-setting').hidden = !settings.split;
  const workspace = $('#workspace');
  const htmlPane = $('#html-pane');
  // Move only the HTML pane. Reparenting the rendered iframe would reload it
  // and destroy its document, selection and undo history.
  if (settings.splitOrder === 'html-first' && workspace.firstElementChild !== htmlPane) workspace.prepend(htmlPane);
  else if (settings.splitOrder === 'rendered-first' && workspace.lastElementChild !== htmlPane) workspace.append(htmlPane);
  $('#file-actions').hidden = !settings.files;
  $('#status-bar').hidden = !settings.count;
  numberGutter && code.dispatch({ effects: numberGutter.reconfigure(settings.lines ? lineNumbers() : []) });
  if (mode === 'split' && !settings.split) setMode('rendered', false);
  for (const [key, value] of Object.entries(settings)) {
    const input = $(`[name="${key}"]`);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
  updateStatus();
  requestAnimationFrame(() => code.requestMeasure());
}

$('#settings-form').addEventListener('submit', event => event.preventDefault());
$('#settings-form').addEventListener('change', event => {
  const key = event.target.name;
  if (!(key in DEFAULT_SETTINGS)) return;
  settings[key] = key === 'splitOrder'
    ? (event.target.value === 'html-first' ? 'html-first' : 'rendered-first')
    : event.target.checked;
  applySettings();
  try {
    localStorage.setItem('openwysiwyg.settings', JSON.stringify(settings));
    if (key === 'remember' && !settings.remember) { localStorage.removeItem(draftKey); saved = false; }
    if (key === 'remember' && settings.remember) { conflict = false; saveDraft(); }
  } catch { notify('Settings could not be saved in this browser.'); }
  updateStatus();
});
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-dialog').addEventListener('click', event => {
  if (event.target !== $('#settings-dialog')) return;
  const rect = event.target.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close();
});
$('#reset-settings').addEventListener('click', () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  applySettings();
  try { localStorage.setItem('openwysiwyg.settings', JSON.stringify(settings)); } catch { notify('Settings could not be saved in this browser.'); }
  saveDraft();
});

$('#format-button').addEventListener('click', () => $('#format-dialog').showModal());
$('#close-format').addEventListener('click', () => $('#format-dialog').close());
$('#format-select').addEventListener('change', event => {
  formatPreference = event.target.value;
  refreshFormat();
  renderSource(true);
  changed();
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.view)));
document.addEventListener('keydown', shortcut);
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#shortcut-mod').textContent = '⌘';

function download(asHTML = false) {
  const format = asHTML ? 'html' : currentFormat;
  const text = asHTML ? outputHTML() : source;
  const extension = { html: '.html', markdown: '.md', text: '.txt' }[format];
  const blob = new Blob([text], { type: { html: 'text/html', markdown: 'text/markdown', text: 'text/plain' }[format] + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/\.[^.]+$/, '') + extension;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (!asHTML) saved = true;
}

function commitReplacement(text, name, hint = name) {
  source = text;
  filename = name;
  formatHint = hint;
  formatPreference = 'auto';
  conflict = false;
  refreshFormat();
  updateCode();
  renderSource(true);
  changed();
  setMode(mode);
}

function requestReplacement(text, name, hint = name) {
  if (!source.trim()) { commitReplacement(text, name, hint); return; }
  pendingReplacement = { text, name, hint };
  $('#replace-dialog').showModal();
}
$('#replace-download').addEventListener('click', () => download());
$('#replace-cancel').addEventListener('click', () => $('#replace-dialog').close());
$('#replace-confirm').addEventListener('click', () => {
  if (pendingReplacement) commitReplacement(pendingReplacement.text, pendingReplacement.name, pendingReplacement.hint);
  pendingReplacement = null;
  $('#replace-dialog').close();
});
$('#replace-dialog').addEventListener('close', () => { pendingReplacement = null; });

$('#file-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { notify('Please open a file smaller than 10 MB.'); return; }
  try {
    requestReplacement(await file.text(), file.name);
  } catch { notify('This file could not be opened.'); }
});

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  if ($('#document-menu').matches(':popover-open')) $('#document-menu').hidePopover();
  switch (button.dataset.action) {
    case 'new': requestReplacement('', 'document.html', ''); break;
    case 'open': $('#file-input').click(); break;
    case 'download': download(); break;
    case 'download-html': download(true); break;
    case 'copy':
      try { await navigator.clipboard.writeText(outputHTML()); notify('HTML code copied.'); }
      catch {
        if (currentFormat === 'html') {
          setMode('html');
          code.dispatch({ selection: { anchor: 0, head: code.state.doc.length } });
        } else {
          setMode('export');
          const range = document.createRange();
          range.selectNodeContents($('#generated-code'));
          const selection = window.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
        }
        notify('HTML selected. Press Ctrl / ⌘ + C to copy.');
      }
      break;
    case 'copy-markdown':
      try { await navigator.clipboard.writeText(currentFormat === 'markdown' ? source : fromHTML(inspectSource(outputHTML()).body, 'markdown')); notify('Markdown copied.'); }
      catch { notify('Clipboard access is unavailable. Use Download to keep your source.'); }
      break;
    case 'copy-formatted':
      try {
        const body = inspectSource(outputHTML()).body;
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([body], { type: 'text/html' }),
          'text/plain': new Blob([fromHTML(body, 'text')], { type: 'text/plain' }),
        })]);
        notify('Formatted text copied.');
      } catch { notify('Formatted copying is unavailable. Use Copy HTML code instead.'); }
      break;
  }
}));

window.addEventListener('beforeunload', event => {
  if (source.trim() && !saved) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('storage', event => {
  if (event.key === draftKey && event.newValue !== event.oldValue && settings.remember) {
    conflict = true;
    saved = false;
    updateStatus();
    notify('The saved draft changed in another tab. This tab is kept separate; download a copy before reloading.', true);
  }
});

refreshFormat();
applySettings();

tinymce.init({
  selector: '#rich-editor',
  license_key: 'gpl',
  skin: false,
  content_css: false,
  content_style: `${contentUi}\n.mce-content-body[data-mce-placeholder]:not(.mce-visualblocks)::before { color:#939990; font-family:system-ui,sans-serif; font-size:16px; font-weight:400; }`,
  iframe_attrs: { title: 'Rendered document', sandbox: 'allow-same-origin' },
  content_security_policy: "default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; form-action 'none'; base-uri 'none'",
  plugins: 'lists advlist link image table searchreplace',
  menubar: false,
  toolbar: 'undo redo | blocks | bold italic underline | bullist numlist | link image table | alignleft aligncenter alignright | removeformat',
  toolbar_mode: 'wrap',
  contextmenu: false,
  statusbar: false,
  promotion: false,
  branding: false,
  resize: false,
  height: '100%',
  highlight_on_focus: false,
  browser_spellcheck: false,
  visual: false,
  object_resizing: true,
  convert_urls: false,
  link_default_target: '_blank',
  link_assume_external_targets: 'https',
  image_title: false,
  paste_data_images: true,
  automatic_uploads: false,
  setup(editor) {
    editor.on('paste', event => {
      const plain = event.clipboardData?.getData('text/plain');
      if (!plain) return;
      const format = detectFormat(plain);
      // Chat and code-copy buttons commonly include unrelated page HTML beside
      // useful Markdown/source text. Prefer the explicit source in that case.
      if (format === 'text') return;
      event.preventDefault();
      const selected = editor.selection.getContent({ format: 'text' }).replace(/\s/g, '');
      const entire = editor.getBody().textContent.replace(/\s/g, '');
      if (!source.trim() || (selected && selected === entire)) {
        commitReplacement(plain, 'document.html', '');
      } else {
        editor.undoManager.transact(() => editor.insertContent(inspectSource(toHTML(plain, format)).body));
        richChanged();
      }
    });
    editor.on('init', () => {
      rich = editor;
      renderSource(true);
      editor.getDoc().addEventListener('keydown', shortcut);
      document.body.dataset.ready = 'true';
      announceReady();
    });
    editor.on('input change undo redo', richChanged);
    editor.on('focus', () => { if (mode === 'split') { clearTimeout(syncTimer); renderSource(); } });
  },
}).catch(error => {
  console.error('Editor initialization failed', error);
  setMode('html', false);
  notify('Rendered editor could not load. Your HTML is available; reload to retry.', true);
});
