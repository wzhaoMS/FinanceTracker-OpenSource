import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseCssAllowed } from './css.js';
import { RESOURCE_CASES } from './resourceCases.js';

const paths = new Set(['assets/image.svg', 'assets/app-123.css', 'assets/font.woff2']);
for (const [name, kind, value] of RESOURCE_CASES) {
  if (kind === 'css') test(`CSS tokenizer refuses ${name}`, () => assert.equal(releaseCssAllowed(value, paths), false));
}
for (const value of [
  'body{background:url("/assets/image.svg");filter:url(#glass-dispersion)}',
  String.raw`body{background:u\72l("/assets/image.svg")}`,
  String.raw`body{background:url("/assets/\69mage.svg")}`,
  'body{background:image-set("/assets/image.svg" 1x,url("/assets/image.svg") 2x type("image/svg+xml"))}',
  'body{background:src("/assets/image.svg")}',
  '@font-face{font-family:Local;src:local("Installed Font"),url("/assets/font.woff2") format("woff2")}',
  '/* @import "https://not-a-resource.invalid"; */ body::before{content:"url(https://not-a-resource.invalid)"}',
  'body{--color:green;color:var(--color)}',
]) {
  test(`CSS tokenizer accepts literal local/non-resource tokens: ${value}`, () => assert.equal(releaseCssAllowed(value, paths), true));
}
for (const value of [
  'body{background:url("/assets/missing.svg")}',
  'body{background:url("data:image/png,1")}',
  'body{background:image-set()}',
  'body{background:image-set(var(--a) 1x)}',
  'body{background:src()}',
  'body{background:url()}',
]) {
  test(`CSS tokenizer refuses missing/unsupported tokens: ${value}`, () => assert.equal(releaseCssAllowed(value, paths), false));
}
