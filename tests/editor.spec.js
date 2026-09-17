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
  const mode = name === 'HTML' ? 'html' : name.toLowerCase();
  await page.locator('[data-view=' + mode + ']').click();
  await expect(page.locator('body')).toHaveAttribute('data-mode', mode);
}

async function writeSource(page, text) {
  if (!['html', 'split'].includes(await page.locator('body').getAttribute('data-mode'))) await view(page, 'HTML');
  await htmlEditor(page).fill(text);
  await expect.poll(() => sourceText(page)).toBe(text);
}

async function fileAction(page, name) {
  if (!await page.locator('#document-menu').isVisible()) await page.locator('#documents-button').click();
  await page.locator('#document-menu').getByRole('button', { name, exact: true }).click();
}

async function chooseFormat(page, format) {
  await page.locator('#format-button').click();
  await page.locator('#format-select').selectOption(format);
  await page.keyboard.press('Escape');
  await expect(page.locator('#format-dialog')).not.toBeVisible();
}

async function pasteIntoVisual(page, plain, html) {
  await visualBody(page).click();
  await visualBody(page).evaluate((body, data) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', data.plain);
    clipboardData.setData('text/html', data.html);
    body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, { plain, html });
}

async function setOptions(page, names) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const name of names) await page.locator(`#settings-form input[name="${name}"]`).check();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

async function setSplitOrder(page, order) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('select[name="splitOrder"]').selectOption(order);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
}

async function expectSplitOrder(page, order, stacked = false) {
  const ids = order === 'html-first' ? ['html-pane', 'rendered-pane'] : ['rendered-pane', 'html-pane'];
  expect(await page.locator('#workspace > #html-pane, #workspace > #rendered-pane').evaluateAll(panes => panes.map(pane => pane.id))).toEqual(ids);
  await expect(page.locator(`#${ids[0]}`)).toBeVisible();
  await expect(page.locator(`#${ids[1]}`)).toBeVisible();
  const first = await page.locator(`#${ids[0]}`).boundingBox();
  const second = await page.locator(`#${ids[1]}`).boundingBox();
  expect(first.width).toBeGreaterThan(0);
  expect(first.height).toBeGreaterThan(0);
  expect(second.width).toBeGreaterThan(0);
  expect(second.height).toBeGreaterThan(0);
  if (stacked) {
    expect(first.y + first.height).toBeLessThanOrEqual(second.y + 1);
    expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1);
  } else {
    expect(first.x + first.width).toBeLessThanOrEqual(second.x + 1);
    expect(Math.abs(first.y - second.y)).toBeLessThanOrEqual(1);
  }
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

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`split order changes both pane positions and document order at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await openEditor(page);
    await setOptions(page, ['split']);
    await writeSource(page, '<p>Both panes stay usable.</p>');
    await view(page, 'Split');
    await expectSplitOrder(page, 'rendered-first', viewport.width < 640);
    await setSplitOrder(page, 'html-first');
    await expectSplitOrder(page, 'html-first', viewport.width < 640);
    await expect(visualBody(page)).toHaveText('Both panes stay usable.');
    await noHorizontalOverflow(page);
    const splitImage = testInfo.outputPath(`html-first-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: splitImage });
    await testInfo.attach('HTML first split layout', { path: splitImage, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await noHorizontalOverflow(page);
    const settingsImage = testInfo.outputPath(`split-order-settings-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: settingsImage });
    await testInfo.attach('Split order setting', { path: settingsImage, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await setSplitOrder(page, 'rendered-first');
    await expectSplitOrder(page, 'rendered-first', viewport.width < 640);
    await noHorizontalOverflow(page);
  });
}

test('split order is conditional, persists across reload, and resets to rendered first', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#split-order-setting')).toBeHidden();
  await page.locator('input[name="split"]').check();
  await expect(page.locator('#split-order-setting')).toBeVisible();
  const order = page.getByRole('combobox', { name: 'Split order' });
  await expect(order).toHaveValue('rendered-first');
  await expect(order.locator('option')).toHaveText([/Rendered left \/ (?:HTML|Source) right/, /(?:HTML|Source) left \/ Rendered right/]);
  await order.selectOption('html-first');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await view(page, 'Split');
  await expectSplitOrder(page, 'html-first');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await view(page, 'Split');
  await expectSplitOrder(page, 'html-first');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(order).toHaveValue('html-first');
  await page.getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(page.locator('input[name="split"]')).not.toBeChecked();
  await expect(page.locator('#split-order-setting')).toBeHidden();
  await expect(page.locator('select[name="splitOrder"]')).toHaveValue('rendered-first');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await setOptions(page, ['split']);
  await view(page, 'Split');
  await expectSplitOrder(page, 'rendered-first');
});

test('reordering split panes preserves exact HTML and both editors still synchronize', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['split']);
  const raw = '<!DOCTYPE html>\n<html lang="en">\n<head><title>Preserve this</title></head>\n<body class="paper">\n  <!-- Keep spacing and entities -->\n  <p data-note="A &amp; B">Original &nbsp; draft.</p>\n</body>\n</html>\n';
  await writeSource(page, raw);
  await view(page, 'Split');
  for (const order of ['html-first', 'rendered-first', 'html-first']) {
    await setSplitOrder(page, order);
    expect(await sourceText(page)).toBe(raw);
  }
  await writeSource(page, raw.replace('Original &nbsp; draft.', 'Edited from HTML.'));
  await expect(rendered(page).locator('p')).toHaveText('Edited from HTML.');
  await appendVisual(page, ' Then edited visually.');
  await expect.poll(() => sourceText(page)).toContain('Edited from HTML. Then edited visually.');
  const edited = await sourceText(page);
  expect(edited).toContain('<head><title>Preserve this</title></head>');
  await setSplitOrder(page, 'rendered-first');
  expect(await sourceText(page)).toBe(edited);
  await expect(rendered(page).locator('p')).toHaveText('Edited from HTML. Then edited visually.');
});

for (const scenario of [
  { name: 'legacy boolean settings', order: undefined },
  { name: 'an invalid stored split order', order: 'sideways' },
]) {
  test(`${scenario.name} restores boolean options and uses rendered-first order`, async ({ page }) => {
    await page.addInitScript(order => {
      const settings = { toolbar: true, split: true, files: true, count: false, lines: true, remember: false };
      if (order !== undefined) settings.splitOrder = order;
      localStorage.setItem('openwysiwyg.settings', JSON.stringify(settings));
    }, scenario.order);
    await openEditor(page);
    await expect(page.locator('.tox-editor-header')).toBeVisible();
    await expect(page.locator('#file-actions')).toBeVisible();
    await expect(page.locator('#status-bar')).toBeHidden();
    await view(page, 'Split');
    await expectSplitOrder(page, 'rendered-first');
    await expect(page.locator('.cm-lineNumbers')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('select[name="splitOrder"]')).toHaveValue('rendered-first');
    for (const name of ['toolbar', 'split', 'files', 'lines']) await expect(page.locator(`input[name="${name}"]`)).toBeChecked();
    for (const name of ['count', 'remember']) await expect(page.locator(`input[name="${name}"]`)).not.toBeChecked();
  });
}

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

test('full documents retain authored layout and typography without added page or table styling', async ({ page }) => {
  await openEditor(page);
  const raw = '<!doctype html>\n<html lang="en"><head><style>body{margin:13px 17px;width:calc(100% - 34px);font:15px/1.4 Arial,sans-serif;color:rgb(31,42,53)}table{width:100%;border-collapse:separate;border-spacing:4px;table-layout:fixed}h1{font-size:24px}</style></head><body><h1>Authored document</h1><p>Keep this layout.</p><table><tr><td>First cell</td><td>Second cell</td></tr></table></body></html>\n';
  await writeSource(page, raw);
  await view(page, 'Rendered');
  await expect(visualBody(page)).toHaveCSS('margin-top', '13px');
  await expect(visualBody(page)).toHaveCSS('margin-left', '17px');
  await expect(visualBody(page)).toHaveCSS('padding-top', '0px');
  await expect(visualBody(page)).toHaveCSS('padding-left', '0px');
  await expect(visualBody(page)).toHaveCSS('max-width', 'none');
  await expect(visualBody(page)).toHaveCSS('font-size', '15px');
  await expect(rendered(page).locator('h1')).toHaveCSS('font-family', 'Arial, sans-serif');
  await expect(rendered(page).locator('table')).toHaveCSS('border-collapse', 'separate');
  await expect(rendered(page).locator('table')).toHaveCSS('table-layout', 'fixed');
  await expect(rendered(page).locator('td').first()).toHaveCSS('border-top-width', '0px');
  await expect(rendered(page).locator('td').first()).toHaveCSS('padding-top', '1px');
  const widths = await visualBody(page).evaluate(body => ({ body: body.getBoundingClientRect().width, viewport: body.ownerDocument.documentElement.clientWidth }));
  expect(widths.body).toBeCloseTo(widths.viewport - 34, 0);
  const pane = await page.locator('#rendered-pane').boundingBox();
  const frame = await page.locator('iframe[title="Rendered document"]').boundingBox();
  expect(Math.abs(frame.x - pane.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(frame.width - pane.width)).toBeLessThanOrEqual(1);
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(raw);
});

test('an unstyled full document uses browser defaults and remains exact when switching', async ({ page }) => {
  await openEditor(page);
  const raw = '<!DOCTYPE html>\n<html><head><title>Native defaults</title></head><body><h1>Heading</h1><p>Unstyled paragraph.</p><table><tr><td>No imposed border</td></tr></table></body></html>';
  await writeSource(page, raw);
  await view(page, 'Rendered');
  await expect(visualBody(page)).toHaveCSS('margin', '8px');
  await expect(visualBody(page)).toHaveCSS('padding', '0px');
  await expect(visualBody(page)).toHaveCSS('max-width', 'none');
  await expect(visualBody(page)).toHaveCSS('font-size', '16px');
  const fonts = await visualBody(page).evaluate(body => ({ body: getComputedStyle(body).fontFamily, heading: getComputedStyle(body.querySelector('h1')).fontFamily }));
  expect(fonts.body).not.toContain('Georgia');
  expect(fonts.heading).toBe(fonts.body);
  await expect(rendered(page).locator('table')).toHaveCSS('border-collapse', 'separate');
  await expect(rendered(page).locator('td')).toHaveCSS('border-top-width', '0px');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(raw);
});

test('fragments have readable defaults after replacing a styled full document', async ({ page }) => {
  await openEditor(page);
  await writeSource(page, '<!doctype html><html style="font-size:32px"><body style="margin:0;font:12px monospace;background:rgb(250,0,0)"><p>Old document</p></body></html>');
  await view(page, 'Rendered');
  await expect(visualBody(page)).toHaveCSS('background-color', 'rgb(250, 0, 0)');
  const fragment = '<h2>A new fragment</h2>\n<p>Readable without configuring anything.</p>';
  await writeSource(page, fragment);
  await view(page, 'Rendered');
  const style = await visualBody(page).evaluate(body => {
    const css = getComputedStyle(body);
    return { font: css.fontFamily, size: parseFloat(css.fontSize), padding: parseFloat(css.paddingLeft), line: parseFloat(css.lineHeight), background: css.backgroundColor };
  });
  expect(style.font).toMatch(/sans-serif|system-ui/i);
  expect(style.size).toBe(16);
  expect(style.line).toBeGreaterThanOrEqual(22);
  expect(style.padding).toBeGreaterThanOrEqual(16);
  expect(style.padding).toBeLessThanOrEqual(40);
  expect(style.background).not.toBe('rgb(250, 0, 0)');
  await expect(rendered(page).locator('h2')).toHaveText('A new fragment');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(fragment);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`embedded editor keeps compact chrome and usable full-document rendering at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/?embed=workbench');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    const header = await page.locator('.app-header').boundingBox();
    expect(header.height).toBeLessThanOrEqual(viewport.width < 640 ? 96 : 52);
    const headerColor = await page.locator('.app-header').evaluate(node => getComputedStyle(node).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
    expect(Math.max(...headerColor)).toBeLessThan(80);
    await noHorizontalOverflow(page);
    const raw = '<!doctype html><html><head><style>body{margin:0;background:white;font:16px Arial,sans-serif}main{padding:16px}table{width:100%;table-layout:fixed}td{overflow-wrap:anywhere}</style></head><body><main><h1>Responsive document</h1><table><tr><td>First column</td><td>Second column</td></tr></table><p>All of the available pane width.</p></main></body></html>';
    await writeSource(page, raw);
    await view(page, 'Rendered');
    await expect(visualBody(page)).toHaveCSS('margin', '0px');
    await expect(visualBody(page)).toHaveCSS('padding', '0px');
    await expect(visualBody(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await noHorizontalOverflow(page);
    const pane = await page.locator('#rendered-pane').boundingBox();
    const frame = await page.locator('iframe[title="Rendered document"]').boundingBox();
    expect(Math.abs(frame.width - pane.width)).toBeLessThanOrEqual(1);
    const docWidth = await visualBody(page).evaluate(body => ({ scroll: body.ownerDocument.documentElement.scrollWidth, width: body.ownerDocument.documentElement.clientWidth }));
    expect(docWidth.scroll).toBeLessThanOrEqual(docWidth.width + 1);
    const screenshot = testInfo.outputPath(`embedded-rendering-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Embedded full-document rendering', { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    for (const name of ['toolbar', 'split', 'files', 'count', 'lines']) await page.locator(`input[name="${name}"]`).check();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await view(page, 'Split');
    await expectSplitOrder(page, 'rendered-first', viewport.width < 640);
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await view(page, 'HTML');
    expect(await sourceText(page)).toBe(raw);
  });
}

test('Workbench receives readiness from the embedded local editor without a new tab', async ({ page, context }) => {
  const editorOrigin = new URL(test.info().project.use.baseURL).origin;
  const harness = 'http://127.0.0.1:4747/__openwysiwyg-embed-test';
  // A fulfilled test route has no local network address space in Chromium.
  // Allow that synthetic parent to reach the real loopback editor.
  await context.grantPermissions(['local-network-access'], { origin: new URL(harness).origin });
  await page.route(harness, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><iframe id="editor" title="Embedded editor" src="${editorOrigin}/?embed=workbench" style="width:100vw;height:100vh;border:0"></iframe><script>window.editorMessages=[];const frame=document.getElementById('editor');addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.origin===${JSON.stringify(editorOrigin)})window.editorMessages.push(event.data)});frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'openwysiwyg:connect'},${JSON.stringify(editorOrigin)}));</script></body></html>`,
  }));
  await page.goto(harness);
  const editor = page.frameLocator('#editor');
  await expect(editor.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => window.editorMessages.some(message => message.type === 'openwysiwyg:ready'))).toBe(true);
  await editor.locator('[data-view=html]').click();
  await editor.locator('.cm-content').fill('<p>Edited inside Workbench.</p>');
  await editor.getByRole('button', { name: 'Rendered', exact: true }).click();
  await expect(editor.frameLocator('iframe[title="Rendered document"]').locator('p')).toHaveText('Edited inside Workbench.');
  expect(page.url()).toBe(harness);
  expect(context.pages()).toHaveLength(1);
});

test('opening HTML, downloading, and cancelling New preserve the document', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['files']);
  const raw = '<!doctype html>\n<title>Imported</title><body><p>From a file &amp; unchanged.</p></body>';
  await page.locator('#file-input').setInputFiles({ name: 'letter.html', mimeType: 'text/html', buffer: Buffer.from(raw) });
  await expect(visualBody(page)).toHaveText('From a file & unchanged.');
  await fileAction(page, 'New');
  await expect(page.getByRole('dialog', { name: 'Replace this document?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(raw);
  const downloading = page.waitForEvent('download');
  await fileAction(page, 'Download');
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('letter.html');
  expect(await readFile(await download.path(), 'utf8')).toBe(raw);
  await fileAction(page, 'New');
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

const markdownExample = '# Morphing menu\n\nA **compact** menu with [documentation](https://example.org/docs).\n\n| Project | Stack |\n| --- | --- |\n| Bloom | React |\n\n```bash\nnpm install bloom-menu\n```\n\n## Next steps\n\n- Try the demo\n- Read the source\n';

test('Markdown is detected and rendered, while switching preserves its exact source', async ({ page }) => {
  await openEditor(page);
  await writeSource(page, markdownExample);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await expect(page.locator('[data-view=html]')).toHaveText('Markdown');
  await expect(page.locator('[data-view=export]')).toHaveText('HTML');
  for (let iteration = 0; iteration < 2; iteration++) {
    await view(page, 'Rendered');
    await expect(rendered(page).locator('h1')).toHaveText('Morphing menu');
    await expect(rendered(page).locator('strong')).toHaveText('compact');
    await expect(rendered(page).getByRole('link', { name: 'documentation' })).toHaveAttribute('href', 'https://example.org/docs');
    await expect(rendered(page).locator('table th')).toHaveText(['Project', 'Stack']);
    await expect(rendered(page).locator('table td')).toHaveText(['Bloom', 'React']);
    await expect(rendered(page).locator('pre code')).toHaveText('npm install bloom-menu\n');
    await expect(rendered(page).locator('ul li')).toHaveText(['Try the demo', 'Read the source']);
    await view(page, 'HTML');
    expect(await sourceText(page)).toBe(markdownExample);
    await view(page, 'Export');
    await expect(page.locator('#generated-code')).toContainText('<h1>Morphing menu</h1>');
    await expect(page.locator('#generated-code')).toContainText('<table>');
    await expect(page.locator('#generated-code')).not.toContainText('**compact**');
    expect(await page.locator('#generated-code').evaluate(element => element.isContentEditable)).toBe(false);
    await view(page, 'HTML');
    expect(await sourceText(page)).toBe(markdownExample);
  }
});

test('format detection distinguishes HTML, Markdown and text, with a non-destructive override', async ({ page }) => {
  await openEditor(page);
  await writeSource(page, '<h2>HTML document</h2>');
  await expect(page.locator('#format-button')).toHaveText('Detected: HTML');
  await expect(page.locator('[data-view=export]')).toBeHidden();
  const text = 'A normal sentence with 2 < 3 and 5 > 4.';
  await writeSource(page, text);
  await expect(page.locator('#format-button')).toHaveText('Detected: Plain text');
  await view(page, 'Rendered');
  await expect(visualBody(page)).toHaveText(text);
  const markdown = '## Interpret this heading\n\n**Emphasis stays in source.**';
  await writeSource(page, markdown);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await chooseFormat(page, 'text');
  await view(page, 'Rendered');
  await expect(visualBody(page)).toContainText('## Interpret this heading');
  await expect(rendered(page).locator('h2, strong')).toHaveCount(0);
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
  await chooseFormat(page, 'auto');
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await view(page, 'Rendered');
  await expect(rendered(page).locator('h2')).toHaveText('Interpret this heading');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
});

test('visual edits to a Markdown draft update Markdown and survive reload', async ({ page }) => {
  await openEditor(page);
  await writeSource(page, '# A Markdown draft\n\nOriginal paragraph.');
  await view(page, 'Rendered');
  await appendVisual(page, ' Edited visually.');
  await view(page, 'HTML');
  const edited = await sourceText(page);
  expect(edited).toContain('# A Markdown draft');
  expect(edited).toContain('Original paragraph. Edited visually.');
  expect(edited).not.toMatch(/<h1|<p>/);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await expect(rendered(page).locator('h1')).toHaveText('A Markdown draft');
  await expect(rendered(page).locator('p')).toHaveText('Original paragraph. Edited visually.');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(edited);
});

test('Markdown task states and fenced HTML survive a visual edit as Markdown', async ({ page }) => {
  await openEditor(page);
  const markdown = '# Checklist\n\n- [x] Finished task\n- [ ] Remaining task\n\n```html\n<p>literal HTML</p>\n```\n\nClosing paragraph.';
  await writeSource(page, markdown);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await view(page, 'Rendered');
  await expect(rendered(page).locator('li')).toHaveText(['☑ Finished task', '☐ Remaining task']);
  await expect(rendered(page).locator('pre code')).toHaveText('<p>literal HTML</p>\n');
  await expect(rendered(page).locator('pre p')).toHaveCount(0);
  await appendVisual(page, ' Edited visually.');
  await view(page, 'HTML');
  const edited = await sourceText(page);
  expect(edited).toMatch(/- +\[x\] Finished task/);
  expect(edited).toMatch(/- +\[ \] Remaining task/);
  expect(edited).toContain('```html\n<p>literal HTML</p>\n```');
  expect(edited).toContain('Closing paragraph. Edited visually.');
  await view(page, 'Rendered');
  await expect(rendered(page).locator('li')).toHaveText(['☑ Finished task', '☐ Remaining task']);
  await expect(rendered(page).locator('pre code')).toHaveText('<p>literal HTML</p>\n');
});

test('pasting Markdown into the rendered editor ignores unrelated clipboard page HTML', async ({ page }) => {
  await openEditor(page);
  const markdown = '# Pasted answer\n\nThe **actual content**.\n\n- First\n- Second';
  await pasteIntoVisual(page, markdown, '<html><body><nav>Skip to content New chat Search Recents Library</nav><main>Unrelated page chrome</main></body></html>');
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await expect(rendered(page).locator('h1')).toHaveText('Pasted answer');
  await expect(rendered(page).locator('strong')).toHaveText('actual content');
  await expect(visualBody(page)).not.toContainText('Skip to content');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
});

test('pasting into the source editor preserves plain Markdown instead of rich clipboard markup', async ({ page }) => {
  await openEditor(page);
  await view(page, 'HTML');
  const markdown = '# Source paste\n\nA **Markdown** document.';
  await htmlEditor(page).focus();
  await htmlEditor(page).evaluate((editor, plain) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', plain);
    clipboardData.setData('text/html', '<nav>New chat Library Recents</nav>');
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, markdown);
  await expect.poll(() => sourceText(page)).toBe(markdown);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await view(page, 'Rendered');
  await expect(rendered(page).locator('h1')).toHaveText('Source paste');
});

test('Copy HTML code puts generated markup on the plain-text clipboard', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['files']);
  await writeSource(page, '# Clipboard heading\n\nA **bold** paragraph.');
  await page.evaluate(() => {
    window.copiedHtml = null;
    Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async text => { window.copiedHtml = text; } });
  });
  await fileAction(page, 'Copy HTML code');
  await expect.poll(() => page.evaluate(() => window.copiedHtml)).toContain('<h1>Clipboard heading</h1>');
  const copied = await page.evaluate(() => window.copiedHtml);
  expect(copied).toContain('<strong>bold</strong>');
  expect(copied).not.toContain('# Clipboard heading');
  expect(copied).not.toContain('**bold**');
  expect(await sourceText(page)).toBe('# Clipboard heading\n\nA **bold** paragraph.');
});

test('Markdown files retain source and extension, and HTML download contains converted markup', async ({ page }) => {
  await openEditor(page);
  await setOptions(page, ['files']);
  const markdown = '# Imported Markdown\n\nKeep **this** source exactly.\n';
  await page.locator('#file-input').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) });
  await expect(page.locator('#format-button')).toContainText('Markdown');
  await expect(rendered(page).locator('h1')).toHaveText('Imported Markdown');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
  let downloading = page.waitForEvent('download');
  await fileAction(page, 'Download');
  const sourceDownload = await downloading;
  expect(sourceDownload.suggestedFilename()).toBe('notes.md');
  expect(await readFile(await sourceDownload.path(), 'utf8')).toBe(markdown);
  downloading = page.waitForEvent('download');
  await fileAction(page, 'Download HTML');
  const htmlDownload = await downloading;
  expect(htmlDownload.suggestedFilename()).toBe('notes.html');
  const html = await readFile(await htmlDownload.path(), 'utf8');
  expect(html).toContain('<h1>Imported Markdown</h1>');
  expect(html).toContain('<strong>this</strong>');
  expect(html).not.toContain('# Imported Markdown');
});

test('a legacy draft containing Markdown is detected without losing the saved source', async ({ page }) => {
  const markdown = '# Existing draft\n\nSaved before Markdown support.\n';
  await page.addInitScript(source => {
    localStorage.setItem('openwysiwyg.document', JSON.stringify({ html: source, name: 'document.html' }));
  }, markdown);
  await openEditor(page);
  await expect(page.locator('#format-button')).toHaveText('Detected: Markdown');
  await expect(rendered(page).locator('h1')).toHaveText('Existing draft');
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
});

test('Markdown rendering strips executable HTML and unsafe links while retaining source', async ({ page }) => {
  await openEditor(page);
  const markdown = '# Safe heading\n\n[Unsafe link](javascript:alert(1))\n\n<img src="/missing" onerror="window.top.markdownInjected=true">\n\n<script>window.top.markdownInjected=true</script>\n\n**Safe text**';
  await writeSource(page, markdown);
  await chooseFormat(page, 'markdown');
  await view(page, 'Rendered');
  await expect(rendered(page).locator('h1')).toHaveText('Safe heading');
  await expect(rendered(page).locator('strong')).toHaveText('Safe text');
  await expect(rendered(page).locator('script, [onerror], [onclick]')).toHaveCount(0);
  expect(await rendered(page).locator('a').getAttribute('href') || '').not.toMatch(/^javascript:/i);
  expect(await page.evaluate(() => window.markdownInjected)).toBeUndefined();
  await view(page, 'HTML');
  expect(await sourceText(page)).toBe(markdown);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`Markdown controls, Documents and format settings fit at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/?embed=workbench');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    await writeSource(page, markdownExample);
    await setOptions(page, ['files', 'split']);
    await noHorizontalOverflow(page);
    await view(page, 'Rendered');
    await expect(page.locator('#format-button')).toBeVisible();
    await expect(page.locator('#settings-button')).toBeVisible();
    await page.locator('#documents-button').click();
    await expect(page.locator('#document-menu')).toBeVisible();
    await expect(page.locator('#document-menu').getByRole('button', { name: 'Copy HTML code', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    const menu = await page.locator('#document-menu').boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.screenshot({ path: testInfo.outputPath(`markdown-documents-${viewport.width}x${viewport.height}.png`) });
    await page.keyboard.press('Escape');
    await page.locator('#format-button').click();
    await expect(page.locator('#format-dialog')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.keyboard.press('Escape');
    await view(page, 'Split');
    await noHorizontalOverflow(page);
    await expectSplitOrder(page, 'rendered-first', viewport.width < 640);
    const docWidth = await visualBody(page).evaluate(body => ({ scroll: body.ownerDocument.documentElement.scrollWidth, width: body.ownerDocument.documentElement.clientWidth }));
    expect(docWidth.scroll).toBeLessThanOrEqual(docWidth.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`markdown-split-${viewport.width}x${viewport.height}.png`) });
  });
}
