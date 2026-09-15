import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const errors = new WeakMap();
const htmlEditor = page => page.locator('.cm-content');
const rendered = page => page.frameLocator('iframe[title="Rendered document"]');
const visualBody = page => rendered(page).locator('body');
const sourceText = page => page.locator('.cm-line').evaluateAll(lines => lines.map(line => {
  const copy = line.cloneNode(true);
  copy.querySelectorAll('.cm-placeholder').forEach(placeholder => placeholder.remove());
  return copy.textContent;
}).join('\n'));

async function openEditor(page) {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}

async function view(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', name === 'HTML' ? 'html' : name.toLowerCase());
}

async function writeSource(page, text) {
  if (await page.locator('body').getAttribute('data-mode') === 'rendered') await view(page, 'HTML');
  await htmlEditor(page).fill(text);
  await expect.poll(() => sourceText(page)).toBe(text);
}

async function setOptions(page, names) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of names) await page.locator(`#settings-form input[name="${name}"]`).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

async function appendVisual(page, text) {
  await visualBody(page).click();
  await visualBody(page).press('ControlOrMeta+End');
  await page.keyboard.insertText(text);
}

async function noHorizontalOverflow(page) {
  const measurements = await page.evaluate(() => {
    const nodes = [document.documentElement, document.body, document.querySelector('.app'), document.querySelector('.app-header')];
    const dialog = document.querySelector('dialog[open]');
    if (dialog) nodes.push(dialog);
    return nodes.map(node => ({ tag: node.id || node.className || node.tagName, scroll: node.scrollWidth, width: node.clientWidth }));
  });
  for (const size of measurements) expect(size.scroll, `${size.tag} horizontal overflow`).toBeLessThanOrEqual(size.width + 1);
}

test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', error => errors.get(page).push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'Uncaught browser errors').toEqual([]);
});

test('starts with only rendered/HTML switching and Settings', async ({ page }, testInfo) => {
  await openEditor(page);
  await expect(page.getByRole('button', { name: 'Rendered', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tox-editor-header')).toBeHidden();
  await expect(page.locator('#split-button')).toBeHidden();
  await expect(page.locator('#file-actions')).toBeHidden();
  await expect(page.locator('#status-bar')).toBeHidden();
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0);
  await expect(visualBody(page)).toBeEditable();
  const defaultImage = testInfo.outputPath('default-1280x800.png');
  await page.screenshot({ path: defaultImage });
  await testInfo.attach('Default interface at 1280×800', { path: defaultImage, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsImage = testInfo.outputPath('settings-1280x800.png');
  await page.screenshot({ path: settingsImage });
  await testInfo.attach('Settings at 1280×800', { path: settingsImage, contentType: 'image/png' });
});

test('switching views preserves original HTML exactly', async ({ page }) => {
  await openEditor(page);
  const raw = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Original title</title></head>\n<body class="paper">\n  <!-- keep this comment -->\n  <h1 data-note="A &amp; B">Hello &nbsp; world</h1>\n  <p style="color: #123456">Spacing    stays.</p>\n</body>\n</html>\n';
  await writeSource(page, raw);
  for (let i = 0; i < 3; i++) {
    await view(page, 'Rendered');
    await expect(rendered(page).locator('h1')).toHaveText('Hello \u00a0 world');
    await view(page, 'HTML');
    expect(await sourceText(page)).toBe(raw);
  }
});

test('rendered editing updates HTML and keyboard switching works in both editors', async ({ page }) => {
  await openEditor(page);
  await writeSource(page, '<p>First draft</p>');
  await htmlEditor(page).press('ControlOrMeta+Shift+E');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'rendered');
  await appendVisual(page, ' with changes');
  await visualBody(page).press('ControlOrMeta+Shift+E');
  await expect(page.locator('body')).toHaveAttribute('data-mode', 'html');
  await expect.poll(() => sourceText(page)).toContain('First draft with changes');
});

test('optional controls and settings persist, and reset restores a quiet interface', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['toolbar', 'split', 'files', 'count', 'lines']);
  await expect(page.locator('.tox-editor-header')).toBeVisible();
  await expect(page.locator('#split-button')).toBeVisible();
  await expect(page.locator('#file-actions')).toBeVisible();
  await expect(page.locator('#status-bar')).toBeVisible();
  await view(page, 'HTML');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.tox-editor-header')).toBeVisible();
  await expect(page.locator('#split-button')).toBeVisible();
  await expect(page.locator('#file-actions')).toBeVisible();
  await expect(page.locator('#status-bar')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of ['toolbar', 'split', 'files', 'count', 'lines', 'remember']) await expect(page.locator(`input[name="${name}"]`)).toBeChecked();
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.tox-editor-header')).toBeHidden();
  await expect(page.locator('#split-button')).toBeHidden();
  await expect(page.locator('#file-actions')).toBeHidden();
  await expect(page.locator('#status-bar')).toBeHidden();
});

test('draft autosave survives reload', async ({ page }) => {
  await openEditor(page);
  const raw = '<h2>Saved locally</h2>\n<p>Draft number 42.</p>';
  await writeSource(page, raw);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(rendered(page).locator('h2')).toHaveText('Saved locally');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(raw);
});

test('split view synchronizes edits in both directions', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['split']);
  await writeSource(page, '<p>Before</p>');
  await view(page, 'Split');
  await expect(visualBody(page)).toHaveText('Before');
  await writeSource(page, '<h2>Updated from HTML</h2>');
  await expect(rendered(page).locator('h2')).toHaveText('Updated from HTML');
  await appendVisual(page, ' and rendered');
  await expect.poll(() => sourceText(page)).toContain('Updated from HTML and rendered');
});

test('a rapid move from HTML to rendered in split view cannot overwrite fresh source', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['split']);
  await writeSource(page, '<p>Old text</p>');
  await view(page, 'Split');
  await page.evaluate(() => {
    document.querySelector('.cm-content').addEventListener('input', () => { window.lastSourceInput = performance.now(); });
    document.querySelector('iframe[title="Rendered document"]').contentDocument.addEventListener('focusin', () => { window.visualFocusAt = performance.now(); });
  });
  await htmlEditor(page).fill('<p>Newest source</p>');
  await page.evaluate(() => document.querySelector('iframe[title="Rendered document"]').contentDocument.body.focus());
  const gap = await page.evaluate(() => window.visualFocusAt - window.lastSourceInput);
  expect(gap, 'Focus should occur before the 220ms synchronization debounce').toBeLessThan(220);
  expect(gap).toBeGreaterThanOrEqual(0);
  await expect(visualBody(page)).toHaveText('Newest source');
  await visualBody(page).press('ControlOrMeta+End');
  await page.keyboard.insertText(' plus visual edit');
  await expect.poll(() => sourceText(page)).toContain('Newest source plus visual edit');
  await view(page, 'HTML');
  expect(await sourceText(page)).not.toContain('Old text');
});

test('HTML scripts and event handlers cannot execute or change the parent interface', async ({ page }) => {
  await openEditor(page);
  const malicious = '<style>.brand{display:none!important} body{background:rgb(240, 1, 1)}</style><p>Safe text</p><script>window.top.injectionExecuted = true; window.top.document.querySelector(".brand").textContent="Changed";</script><img src="/invalid-image" onerror="window.top.injectionExecuted=true"><a href="javascript:window.top.injectionExecuted=true">Danger</a><iframe srcdoc="<script>parent.injectionExecuted=true</script>"></iframe>';
  await writeSource(page, malicious);
  await view(page, 'Rendered');
  await expect(rendered(page).getByText('Safe text', { exact: true })).toBeVisible();
  await expect(page.locator('.brand')).toBeVisible();
  await expect(page.locator('.brand')).toHaveText('OpenWysiwyg');
  expect(await page.evaluate(() => window.injectionExecuted)).toBeUndefined();
  await expect(rendered(page).locator('script, iframe, [onerror], [onclick]')).toHaveCount(0);
  expect((await rendered(page).locator('a').getAttribute('href')) ?? '').not.toMatch(/^javascript:/i);
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(malicious);
});

test('full document head, styles and body attributes survive a visual edit', async ({ page }) => {
  await openEditor(page);
  const before = '<!DOCTYPE html>\n<html lang="fr">\n<head data-owner="Paul"><meta charset="utf-8"><title>My export</title><style>p{color:rgb(18, 52, 86)}</style></head>\n<body class="letter" style="background-color:rgb(245, 240, 230)" data-page="one">';
  const after = '</body>\n</html><!-- end -->';
  await writeSource(page, `${before}<p>Bonjour</p>${after}`);
  await view(page, 'Rendered');
  await expect(rendered(page).locator('p')).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(visualBody(page)).toHaveClass(/\bletter\b/);
  await expect(visualBody(page)).toHaveCSS('background-color', 'rgb(245, 240, 230)');
  await expect(rendered(page).locator('html')).toHaveAttribute('lang', 'fr');
  await appendVisual(page, ' Paul');
  await view(page, 'HTML');
  const actual = await sourceText(page);
  expect(actual.startsWith(before)).toBe(true);
  expect(actual.endsWith(after)).toBe(true);
  expect(actual).toContain('Bonjour Paul');
});

test('opening HTML, downloading, and cancelling New preserve the document', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['files']);
  const raw = '<!doctype html>\n<title>Imported</title><body><p>From a file &amp; unchanged.</p></body>';
  await page.locator('#file-input').setInputFiles({ name: 'letter.html', mimeType: 'text/html', buffer: Buffer.from(raw) });
  await expect(visualBody(page)).toHaveText('From a file & unchanged.');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Replace this document?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(raw);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('letter.html');
  expect(await readFile(await download.path(), 'utf8')).toBe(raw);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect.poll(() => sourceText(page)).toBe('');
});

test('cancelling an imported replacement keeps the existing draft', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['files']);
  await writeSource(page, '<p>Keep my existing draft</p>');
  await page.locator('#file-input').setInputFiles({ name: 'other.html', mimeType: 'text/html', buffer: Buffer.from('<p>Replacement</p>') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await sourceText(page)).toBe('<p>Keep my existing draft</p>');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(visualBody(page)).toHaveText('Keep my existing draft');
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`no horizontal overflow at ${viewport.width}×${viewport.height}, including settings and all options`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEditor(page);
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await noHorizontalOverflow(page);
    for (const name of ['toolbar', 'split', 'files', 'count', 'lines']) await page.locator(`input[name="${name}"]`).check();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await noHorizontalOverflow(page);
    await writeSource(page, `<p>${'LongUnbrokenText'.repeat(35)}</p><table><tbody><tr><td>First</td><td>Second</td></tr></tbody></table>`);
    await noHorizontalOverflow(page);
    await view(page, 'Rendered');
    await noHorizontalOverflow(page);
    const richWidth = await visualBody(page).evaluate(body => ({ scroll: body.ownerDocument.documentElement.scrollWidth, width: body.ownerDocument.documentElement.clientWidth }));
    expect(richWidth.scroll).toBeLessThanOrEqual(richWidth.width + 1);
    await view(page, 'Split');
    await expect(page.locator('#html-pane')).toBeVisible();
    await expect(page.locator('#rendered-pane')).toBeVisible();
    await noHorizontalOverflow(page);
  });
}
