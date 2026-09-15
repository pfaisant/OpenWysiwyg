import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

// An explicit source allow-list prevents local drafts, environment files and test
// artifacts from being published. No Git commit or platform ZIP program is needed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const entries = new Map();
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const addFile = async (path, name = relative(root, path).replaceAll('\\', '/')) => {
  entries.set(`OpenWysiwyg/${name}`, await readFile(path));
};

async function addTree(path, prefix) {
  for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith('.') || /^(?:node_modules|dist|tests?|screenshots?|test-results|playwright-report)$/i.test(item.name)) continue;
    if (/\.(?:log|bak|zip|tar|gz)$/i.test(item.name)) continue;
    const child = join(path, item.name);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory()) await addTree(child, name);
    else if (item.isFile()) await addFile(child, name);
  }
}

await stat(join(dist, 'index.html')); // Run only after Vite has finished.
for (const name of ['package.json', 'package-lock.json', 'index.html', 'AGENTS.md', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', '.gitignore']) {
  await addFile(join(root, name), name);
}
for (const name of ['vite.config.js', 'vite.config.mjs', 'vite.config.ts']) {
  try { await addFile(join(root, name), name); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const name of ['src', 'scripts', 'public']) await addTree(join(root, name), name);
try { await addTree(join(root, 'deploy'), 'deploy'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const lock = await readJson(join(root, 'package-lock.json'));
let notices = `${await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')}\n\n${await readFile(join(root, 'LICENSE'), 'utf8')}\n`;
const packages = [];
for (const [path, locked] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || locked.dev || locked.devOptional) continue;
  if (!path.startsWith('node_modules/') || path.includes('..')) throw new Error(`Unexpected dependency path: ${path}`);
  const folder = join(root, path);
  const pkg = await readJson(join(folder, 'package.json'));
  if (pkg.version !== locked.version) throw new Error(`Run npm ci: ${pkg.name} does not match package-lock.json`);
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const record = { name: pkg.name, version: pkg.version, license: pkg.license, repository, resolved: locked.resolved, integrity: locked.integrity };
  packages.push(record);
  const licenseFiles = (await readdir(folder)).filter((name) => /^(?:licen[cs]e|copying|notices?)(?:[.\-]|$)/i.test(name)).sort();
  if (!licenseFiles.length) throw new Error(`Missing license text for ${pkg.name}`);
  notices += `\n\n${'='.repeat(72)}\n${pkg.name}@${pkg.version}\nLicense: ${pkg.license}\nUpstream: ${repository ?? pkg.homepage ?? locked.resolved}\n`;
  for (const name of licenseFiles) {
    const contents = await readFile(join(folder, name));
    entries.set(`OpenWysiwyg/third-party-licenses/${pkg.name}/${name}`, contents);
    notices += `\n--- ${name} ---\n${contents.toString('utf8')}\n`;
  }
}

// DOMPurify ships its original TypeScript source in npm. Preserve it together
// with its licenses; the application selects the MPL-2.0 license option.
await addTree(join(root, 'node_modules/dompurify/src'), 'vendor/dompurify/src');
await addFile(join(root, 'node_modules/dompurify/package.json'), 'vendor/dompurify/package.json');
for (const name of ['LICENSE', 'LICENSE-MPL']) await addFile(join(root, 'node_modules/dompurify', name), `vendor/dompurify/${name}`);

const sources = await readJson(join(root, 'public/sources/manifest.json'));
const installedTiny = packages.find((pkg) => pkg.name === 'tinymce');
if (sources.tinymce.version !== installedTiny?.version) throw new Error('Update the TinyMCE source manifest for the installed version before deploying.');
const tinyCode = await readFile(join(root, 'node_modules/tinymce/tinymce.js'), 'utf8');
if (!tinyCode.includes(`@license DOMPurify ${sources['tinymce-dompurify'].version} |`)) throw new Error('Update the source manifest for the DOMPurify version embedded in TinyMCE.');
notices += `\n\nDOMPurify ${sources['tinymce-dompurify'].version}, embedded in TinyMCE\nCopyright (c) Cure53 and other contributors\nMPL-2.0 OR Apache-2.0 (MPL-2.0 selected). The full texts appear in the DOMPurify section above.\nSource: ${sources['tinymce-dompurify'].url}\n`;
const cacheDir = join(root, 'node_modules/.cache/openwysiwyg');
await mkdir(cacheDir, { recursive: true });
await mkdir(join(dist, 'sources'), { recursive: true });
for (const source of Object.values(sources)) {
  const cachedArchive = join(cacheDir, source.filename);
  let archive;
  try { archive = await readFile(cachedArchive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`Downloading ${source.filename}…`);
    const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Source download failed: HTTP ${response.status} (${source.filename})`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(archive).digest('hex') !== source.sha256) throw new Error(`Source archive SHA-256 mismatch: ${source.filename}`);
  await writeFile(cachedArchive, archive);
  await copyFile(cachedArchive, join(dist, 'sources', source.filename));
}
await writeFile(join(dist, 'sources/manifest.json'), `${JSON.stringify({ ...sources, packages }, null, 2)}\n`);
await writeFile(join(dist, 'licenses.txt'), notices);
entries.set('OpenWysiwyg/third-party-licenses/packages.json', Buffer.from(`${JSON.stringify(packages, null, 2)}\n`));
entries.set('OpenWysiwyg/third-party-licenses/all-notices.txt', Buffer.from(notices));

// Deterministic ZIP with deflated UTF-8 files, fixed timestamps and CRC32.
// ZIP32 is sufficient: app sources are a few hundred KB, not multi-GB archives.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
const local = [];
const central = [];
let offset = 0;
for (const [path, raw] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
  const name = Buffer.from(path);
  const compressed = deflateRawSync(raw, { level: 9 });
  const crc = crc32(raw);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(33, 12); // 1980-01-01
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(raw.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, compressed);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  header.copy(directory, 8, 6, 28);
  directory.writeUInt32LE(offset, 42);
  central.push(directory, name);
  offset += header.length + name.length + compressed.length;
}
const centralSize = central.reduce((total, buffer) => total + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.size, 8);
end.writeUInt16LE(entries.size, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
await writeFile(join(dist, 'source.zip'), Buffer.concat([...local, ...central, end]));
console.log(`Packaged ${entries.size} source files, ${packages.length} dependency notices and ${Object.keys(sources).length} upstream source archives.`);
