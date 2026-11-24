#!/usr/bin/env node
// Rasterizes the brand SVGs in this folder to the PNGs next to them, with the repository's own Playwright Chromium.
//
//   node docs/assets/brand/render.mjs           render and write every PNG
//   node docs/assets/brand/render.mjs --check   render in memory and fail if a PNG on disk has different pixels
//
// Needs the repository's dependencies (`npm install`: @playwright/test and the Geist fonts) and Playwright's Chromium
// (once per machine: `node node_modules/@playwright/test/cli.js install chromium`).
//
// The output is deterministic: a fixed viewport and device scale factor, the sRGB color profile, grayscale
// antialiasing, fonts loaded from node_modules (never from the system), no network, and every PNG re-encoded with
// only the IHDR, IDAT and IEND chunks (no timestamps, text or color-profile metadata). Pixels can differ slightly
// between operating systems where text is involved (each platform rasterizes glyphs its own way); --check compares
// pixels, not bytes, so a different Node.js zlib does not count as a change.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const require = createRequire(path.join(repo, 'apps', 'web', 'package.json'));

/** Every PNG and the SVG it comes from. `opaque` PNGs must not contain a transparent pixel. */
const JOBS = [
  { svg: 'favicon.svg', png: 'favicon-32.png', width: 32, height: 32 },
  { svg: 'mark.svg', png: 'favicon-192.png', width: 192, height: 192 },
  { svg: 'app-icon.svg', png: 'apple-touch-icon-180.png', width: 180, height: 180, opaque: true },
  { svg: 'social-preview.svg', png: 'social-preview.png', width: 1280, height: 640, opaque: true, maxBytes: 1_000_000 },
];

const FONTS = [
  { family: 'Geist', file: '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2' },
  { family: 'Geist Mono', file: '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2' },
];

const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--check');
if (unknown.length) {
  console.error(`render: unknown argument ${unknown[0]}\nusage: node docs/assets/brand/render.mjs [--check]`);
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------------------------------
// PNG decoding and encoding (8-bit RGB or RGBA, not interlaced: what Chromium writes)
// ---------------------------------------------------------------------------------------------------------------------

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decodes a PNG to 8-bit RGBA pixels. */
function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let header = null;
  const data = [];
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header || header.depth !== 8 || header.interlace !== 0 || (header.color !== 2 && header.color !== 6)) {
    throw new Error('unsupported PNG layout (expected 8-bit RGB or RGBA, not interlaced)');
  }
  const { width, height } = header;
  const channels = header.color === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? rows[row + i - channels] : 0;
      const b = y > 0 ? rows[row - stride + i] : 0;
      const c = y > 0 && i >= channels ? rows[row - stride + i - channels] : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      rows[row + i] = (raw[source + i] + predictor) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: rows };
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let p = 0; p < width * height; p += 1) rows.copy(rgba, p * 4, p * 3, p * 3 + 3);
  return { width, height, rgba };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/** Encodes RGBA pixels as a metadata-free PNG; RGB when every pixel is opaque. Per-row filters by minimum sum. */
function encodePng({ width, height, rgba }) {
  const opaque = isOpaque(rgba);
  const channels = opaque ? 3 : 4;
  const stride = width * channels;
  const pixels = opaque ? Buffer.alloc(width * height * 3) : rgba;
  if (opaque) for (let p = 0; p < width * height; p += 1) rgba.copy(pixels, p * 3, p * 4, p * 4 + 3);
  const filtered = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter += 1) {
      let sum = 0;
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? pixels[row + i - channels] : 0;
        const b = y > 0 ? pixels[row - stride + i] : 0;
        const c = y > 0 && i >= channels ? pixels[row - stride + i - channels] : 0;
        const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
        const value = (pixels[row + i] - predictor) & 0xff;
        candidate[i] = value;
        sum += value < 128 ? value : 256 - value;
      }
      if (sum < best) {
        best = sum;
        filtered[y * (stride + 1)] = filter;
        candidate.copy(filtered, y * (stride + 1) + 1);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(filtered, { level: 9, memLevel: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function isOpaque(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0xff) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------------

function fontFaces() {
  return FONTS.map(({ family, file }) => {
    const data = fs.readFileSync(require.resolve(file)).toString('base64');
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${data}) format('woff2');font-weight:100 900;font-style:normal}`;
  }).join('\n');
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('@playwright/test'));
  } catch {
    console.error('render: @playwright/test is not installed; run `npm install` at the repository root first');
    process.exit(1);
  }
  let browser;
  try {
    browser = await chromium.launch({
      args: ['--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
  } catch (error) {
    console.error(`render: cannot start Playwright's Chromium (${String(error.message).split('\n')[0]})`);
    console.error('install it once with: node node_modules/@playwright/test/cli.js install chromium');
    process.exit(1);
  }
  const faces = fontFaces();
  const context = await browser.newContext({ deviceScaleFactor: 1, offline: true, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const problems = [];
  try {
    for (const job of JOBS) {
      const svg = fs.readFileSync(path.join(here, job.svg), 'utf8').replace(/^<\?xml[^>]*>\s*/, '');
      await page.setViewportSize({ width: job.width, height: job.height });
      await page.setContent(`<!doctype html><meta charset="utf-8"><style>${faces}
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
body>svg{display:block;width:${job.width}px;height:${job.height}px}</style>${svg}`);
      await page.evaluate(async () => {
        await Promise.all([...document.fonts].map((face) => face.load()));
        await document.fonts.ready;
      });
      const shot = await page.screenshot({
        clip: { x: 0, y: 0, width: job.width, height: job.height },
        omitBackground: true,
        animations: 'disabled',
        caret: 'hide',
      });
      const image = decodePng(shot);
      const png = encodePng(image);
      const target = path.join(here, job.png);
      if (job.opaque && !isOpaque(image.rgba)) problems.push(`${job.png}: has transparent pixels`);
      if (job.maxBytes && png.length > job.maxBytes) problems.push(`${job.png}: ${png.length} bytes, over ${job.maxBytes}`);
      if (check) {
        let same = false;
        if (fs.existsSync(target)) {
          const current = decodePng(fs.readFileSync(target));
          same = current.width === image.width && current.height === image.height && current.rgba.equals(image.rgba);
        }
        console.log(`${same ? 'same   ' : 'DIFFERS'} ${job.png}`);
        if (!same) problems.push(`${job.png}: out of date (run node docs/assets/brand/render.mjs)`);
      } else {
        fs.writeFileSync(target, png);
        console.log(`wrote ${job.png.padEnd(26)} ${job.width}x${job.height}  ${png.length} bytes  from ${job.svg}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (problems.length) {
    for (const problem of problems) console.error(`render: ${problem}`);
    process.exit(1);
  }
}

await main();
