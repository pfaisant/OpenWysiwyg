import { Marked } from 'marked';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import DOMPurify from 'dompurify';

const sanitizeOptions = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'base', 'meta', 'link', 'style'],
  FORBID_ATTR: ['srcdoc', 'autofocus'],
  ADD_ATTR: ['target'],
};

const markdown = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    // Real inputs would be removed by the rendered editor's sanitizer. These
    // markers survive that boundary and can be converted back to task syntax.
    checkbox({ checked }) {
      return `<span data-task="${checked ? 'checked' : 'unchecked'}" contenteditable="false" aria-label="${checked ? 'Completed task' : 'Incomplete task'}">${checked ? '☑' : '☐'}</span> `;
    },
  },
});

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  strongDelimiter: '**',
});
turndown.use(gfm);
turndown.addRule('taskMarker', {
  filter: node => node.nodeName === 'SPAN' && ['checked', 'unchecked'].includes(node.getAttribute('data-task')),
  replacement: (_content, node) => node.getAttribute('data-task') === 'checked' ? '[x]' : '[ ]',
});
turndown.addRule('strikethrough', {
  filter: ['del', 's', 'strike'],
  replacement: content => `~~${content}~~`,
});
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content, node) => {
    const prefix = node.previousElementSibling ? ' ' : '| ';
    return `${prefix}${content.trim().replaceAll('|', '\\|').replace(/\n+/g, '<br>')} |`;
  },
});

const markdownTokens = new Set(['heading', 'list', 'blockquote', 'table', 'code', 'codespan', 'strong', 'em', 'del', 'image', 'hr']);

/** Detection is a hint only; callers keep the original source unchanged. */
export function detectFormat(source, filename = '') {
  const extension = filename.split(/[\\/]/).pop().match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'txt') return 'text';
  if (!source.trim()) return 'html';

  const tokens = markdown.lexer(source);
  // Inspect parsed HTML tokens, never the contents of fenced or inline code.
  // Explicit full documents remain HTML even if their text contains asterisks.
  let documentHTML = false;
  let hasHTML = false;
  let hasMarkdown = false;
  markdown.walkTokens(tokens, token => {
    if (token.type === 'html') {
      hasHTML = true;
      if (/^\s*(?:<!doctype\b|<(?:html|head|body)(?:\s|>))/i.test(token.raw)) documentHTML = true;
    } else if (markdownTokens.has(token.type)) {
      hasMarkdown = true;
    } else if (token.type === 'link' && /^(?:\[|<)/.test(token.raw)) {
      // Bare URLs are ordinary text; explicit Markdown links and autolinks
      // carry markup. Email autolinks are never mistaken for HTML tags.
      hasMarkdown = true;
    }
  });
  if (documentHTML) return 'html';
  if (hasMarkdown) return 'markdown';
  return hasHTML ? 'html' : 'text';
}

function escapeText(source) {
  return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Converts for display/export without changing the caller's canonical source. */
export function toHTML(source, format) {
  if (format === 'html') return source;
  if (format === 'markdown') return DOMPurify.sanitize(markdown.parse(source), sanitizeOptions);
  if (!source) return '';
  return source.replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map(paragraph => `<p>${escapeText(paragraph).replaceAll('\n', '<br>')}</p>`).join('\n');
}

const blockTags = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'HEADER', 'HR', 'MAIN', 'NAV', 'OL', 'SECTION', 'TABLE', 'UL']);
const paragraphTags = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function plainText(node) {
  if (node.nodeType === 3) return node.textContent.replace(/[\t\r\n ]+/g, ' ');
  if (node.nodeType !== 1) return '';
  const tag = node.nodeName;
  if (tag === 'BR') return '\n';
  if (tag === 'PRE') return `\n\n${node.textContent}\n\n`;
  if (tag === 'IMG') return node.getAttribute('alt') || '';
  if (tag === 'SPAN' && node.hasAttribute('data-task')) return node.getAttribute('data-task') === 'checked' ? '[x]' : '[ ]';
  if (tag === 'TR') return `${[...node.children].map(cell => plainText(cell).trim()).join('\t')}\n`;
  const content = [...node.childNodes].map(plainText).join('');
  if (tag === 'LI') {
    const list = node.parentElement;
    const marker = list?.nodeName === 'OL'
      ? `${(Number(list.getAttribute('start')) || 1) + [...list.children].indexOf(node)}.`
      : '•';
    return `${marker} ${content.trim()}\n`;
  }
  if (paragraphTags.has(tag)) return `\n\n${content.trim()}\n\n`;
  if (blockTags.has(tag)) return `\n${content}\n`;
  return content;
}

export function fromHTML(source, format) {
  if (format === 'html') return source;
  // A detached sanitized body keeps conversion local and scripts inert.
  const body = DOMPurify.sanitize(source, { ...sanitizeOptions, RETURN_DOM: true });
  if (format === 'markdown') {
    // The GFM plugin expects a first row. Empty tables contain no content to
    // convert, and removing them avoids that upstream edge case.
    body.querySelectorAll('table').forEach(table => { if (!table.rows.length) table.remove(); });
    return turndown.turndown(body);
  }
  return plainText(body).replaceAll('\u00a0', ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
