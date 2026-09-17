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
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { DEFAULT_SETTINGS, readSettings, inspectSource, replaceBody, countWords, escapeText } from './document.js';
import './style.css';

const $ = selector => document.querySelector(selector);
const settings = readSettings({ getItem: key => localStorage.getItem(key) });
let source = '';
let filename = 'document.html';
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

function notify(message, persistent = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  if (!persistent) noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 4200);
}

try {
  if (settings.remember) {
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (draft && typeof draft.html === 'string') {
      source = draft.html;
      if (typeof draft.name === 'string') filename = draft.name;
    }
  }
} catch { notify('This browser cannot restore the saved draft.'); }

const code = new EditorView({
  parent: $('#code-editor'),
  state: EditorState.create({
    doc: source,
    extensions: [
      html(), history(), bracketMatching(), indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle),
      EditorView.lineWrapping,
      numberGutter.of(settings.lines ? lineNumbers() : []),
      placeholder('Paste or write HTML…'),
      EditorView.contentAttributes.of({ 'aria-label': 'HTML source', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged || update.transactions.every(tr => tr.annotation(externalChange))) return;
        source = update.state.doc.toString();
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
      localStorage.setItem(draftKey, JSON.stringify({ html: source, name: filename }));
      saved = true;
    } catch { notify('Draft could not be saved. Enable File actions in Settings to download a copy.', true); }
  }
  updateStatus();
}

function changed() { saveDraft(); }

function updateStatus() {
  if (settings.count) {
    const words = countWords(source);
    $('#word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
    $('#save-state').textContent = settings.remember && saved ? 'Saved in this browser' : 'Not saved';
  }
}

function renderSource(resetUndo = false) {
  if (!rich || (richSource === source && !resetUndo)) return;
  const parsed = inspectSource(source);
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
  source = replaceBody(source, body);
  richSource = source;
  updateCode();
  changed();
}

function setMode(next, focus = true) {
  if (next === 'split' && !settings.split) next = 'rendered';
  clearTimeout(syncTimer);
  // Never read stale rich content after typing in the source pane.
  if (mode === 'rendered') richChanged();
  mode = next;
  if (mode !== 'html') renderSource();
  updateCode();
  document.body.dataset.mode = mode;
  $('#rendered-pane').hidden = mode === 'html';
  $('#html-pane').hidden = mode === 'rendered';
  document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === mode)));
  requestAnimationFrame(() => {
    code.requestMeasure();
    if (focus) { if (mode === 'html' || (mode === 'split' && settings.splitOrder === 'html-first')) code.focus(); else rich?.focus(); }
  });
}

function shortcut(event) {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    setMode(mode === 'html' ? 'rendered' : 'html');
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
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.view)));
document.addEventListener('keydown', shortcut);
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('#shortcut-mod').textContent = '⌘';

function download() {
  const blob = new Blob([source], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.replace(/\.[^.]+$/, '') + '.html';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  saved = true;
}

function commitReplacement(html, name) {
  source = html;
  filename = name;
  conflict = false;
  updateCode();
  renderSource(true);
  changed();
  setMode(mode);
}

function requestReplacement(html, name) {
  if (!source.trim()) { commitReplacement(html, name); return; }
  pendingReplacement = { html, name };
  $('#replace-dialog').showModal();
}
$('#replace-download').addEventListener('click', download);
$('#replace-cancel').addEventListener('click', () => $('#replace-dialog').close());
$('#replace-confirm').addEventListener('click', () => {
  if (pendingReplacement) commitReplacement(pendingReplacement.html, pendingReplacement.name);
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
    let text = await file.text();
    if (/\.txt$/i.test(file.name)) text = `<pre>${escapeText(text)}</pre>`;
    requestReplacement(text, file.name);
  } catch { notify('This file could not be opened.'); }
});

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
  switch (button.dataset.action) {
    case 'new': requestReplacement('', 'document.html'); break;
    case 'open': $('#file-input').click(); break;
    case 'download': download(); break;
    case 'copy':
      try { await navigator.clipboard.writeText(source); notify('HTML copied.'); }
      catch { setMode('html'); code.dispatch({ selection: { anchor: 0, head: code.state.doc.length } }); notify('Press Ctrl / ⌘ + C to copy the selected HTML.'); }
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

applySettings();

tinymce.init({
  selector: '#rich-editor',
  license_key: 'gpl',
  skin: false,
  content_css: false,
  content_style: `${contentUi}\nhtml { min-height: 100%; background: #fff; } body { box-sizing: border-box; max-width: 820px; margin: 0 auto; padding: 54px 56px 100px; color: #252823; font: 17px/1.7 Georgia, 'Times New Roman', serif; overflow-wrap: anywhere; } h1,h2,h3,h4 { font-family: system-ui,sans-serif; line-height:1.25; letter-spacing:-.025em; } h1 { font-size: 34px; } p { margin:0 0 1em; } a { color:#405e75; } img,video { max-width:100%; height:auto; } table { max-width:100%; border-collapse:collapse; } td,th { border:1px solid #d9ddd6; padding:8px; overflow-wrap:anywhere; } pre { white-space:pre-wrap; font-size:14px; padding:16px; background:#f5f5f3; } blockquote { border-left:2px solid #d6dbd2; margin-left:0; padding-left:20px; } .mce-content-body[data-mce-placeholder]:not(.mce-visualblocks)::before { color:#a1a49d; font-family:system-ui,sans-serif; font-size:16px; font-weight:400; } @media(max-width:600px) { body { padding:28px 24px 70px; } }`,
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
  object_resizing: true,
  convert_urls: false,
  link_default_target: '_blank',
  link_assume_external_targets: 'https',
  image_title: false,
  paste_data_images: true,
  automatic_uploads: false,
  setup(editor) {
    editor.on('init', () => {
      rich = editor;
      renderSource(true);
      editor.getDoc().addEventListener('keydown', shortcut);
      document.body.dataset.ready = 'true';
    });
    editor.on('input change undo redo', richChanged);
    editor.on('focus', () => { if (mode === 'split') { clearTimeout(syncTimer); renderSource(); } });
  },
}).catch(error => {
  console.error('Editor initialization failed', error);
  setMode('html', false);
  notify('Rendered editor could not load. Your HTML is available; reload to retry.', true);
});
