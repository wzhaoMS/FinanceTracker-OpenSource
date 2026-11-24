# Holdr brand guide

Holdr is a private, local-first finance hub for U.S. households: investing, gold and silver, everyday card spending and
card benefits, on your own computer, with a read-only MCP server so AI agents can read the same data. This page
covers the name, the logo files in [`docs/assets/brand/`](assets/brand/), colors, type, and the rules for screenshots.

- [Name and copy](#name-and-copy)
- [Logo files](#logo-files)
- [Clear space and minimum size](#clear-space-and-minimum-size)
- [Color](#color)
- [Type](#type)
- [Do and don't](#do-and-dont)
- [Alt text](#alt-text)
- [Using the assets](#using-the-assets)
- [Screenshots](#screenshots)
- [Re-rendering the PNGs](#re-rendering-the-pngs)
- [Trademarks and advice](#trademarks-and-advice)

## Name and copy

- **Holdr** is the product name (and the project codename for now). One word, capital H, no vowel before the r.
  Not HOLDR, HoldR, Holdr.app or "Holder".
- Use lowercase `holdr` only where code needs it: commands, package and server names, paths.
- The repository is still named FinanceTracker; the product it ships is Holdr.
- **Tagline:** Humans click. Agents read.
- **Subline:** A private, local-first finance hub for U.S. households.
- Keep both exactly as written: sentence case, with their periods, no emoji. "Humans click." is the web app;
  "Agents read." is the read-only MCP server and API.

## Logo files

The mark is a rounded evergreen tile with two stacked gold ingot bars that form an H. The wordmark is custom
geometric lettering drawn as vector paths, not a font: don't retype "Holdr" in a typeface to imitate it.

"-light" files are for light backgrounds (dark lettering); "-dark" files are for dark backgrounds.

| File | What it is | Use it for |
|---|---|---|
| `lockup-light.svg`, `lockup-dark.svg` | Mark and wordmark side by side | The default logo: headers, docs sites, slides |
| `mark.svg` | Full-color tile mark, 64 × 64 | Avatars, docs, app UI, anywhere 24 px or larger |
| `favicon.svg` | Simplified mark drawn on a 32-unit pixel grid, two-tone bars, no seam | Browser tabs and anything under 24 px |
| `mark-mono.svg` | One color (`currentColor`), bars knocked out of the tile | Single-color use: print, embossing, inline icons. As an `<img>` it renders black; inline it or set `color` to recolor it |
| `wordmark-light.svg`, `wordmark-dark.svg` | The word alone | Only where the mark already appears nearby |
| `app-icon.svg` | The mark as a full-bleed square (no rounded corners) | Platforms that apply their own mask: iOS home screen, Android maskable icons |
| `banner-light.svg`, `banner-dark.svg` | 1280 × 320 card: lockup and tagline | The README hero, swapped by color scheme |
| `social-preview.svg` | 1280 × 640 card: lockup, tagline, subline, four feature chips, a demo chart and a read-only MCP reply | Source of `social-preview.png` |
| `social-preview.png` | 1280 × 640, opaque, under 1 MB | GitHub social preview and link unfurls |
| `favicon-32.png` | Rendered from `favicon.svg` | PNG fallback for browsers without SVG favicons |
| `favicon-192.png` | Rendered from `mark.svg` | Web app manifest and Android home screen |
| `apple-touch-icon-180.png` | Rendered from `app-icon.svg` | iOS home screen (`apple-touch-icon`) |

All SVGs are hand-optimized: no editor metadata, no embedded images, a `<title>` for assistive technology, and IDs
prefixed per file so several can be inlined on one page.

## Clear space and minimum size

- **Clear space:** keep a quarter of the mark's height empty on every side of the mark or the lockup (16 units in the
  64-unit mark). Nothing else (text, edges, other logos) goes inside it. The banners carry their own clear space.
- **Minimum size:** mark 16 px (use `favicon.svg` below 24 px), lockup 24 px tall, wordmark 14 px tall.
- **Banner:** show it at 600 px wide or more where you can; below that the tagline gets small, so keep the tagline in
  the alt text and in the text under the banner.

## Color

Light-theme colors are for white or Paper backgrounds; dark-theme colors are for GitHub dark (`#0D1117`) or Ink.
Contrast ratios are WCAG 2.x, against `#FFFFFF` (light) and `#0D1117` (dark).

| Role | Light theme | Dark theme | Use |
|---|---|---|---|
| Evergreen | `#0F766E`, 5.47:1 | `#34D399`, 9.84:1 | Brand color, links, "Agents read.", positive change. White text on `#0F766E` is 5.47:1 |
| Bullion | `#A16207`, 4.92:1 | `#FACC15`, 12.36:1 | Gold accents, gold and silver, highlights. Ink text on `#FACC15` is 12.23:1 |
| Ink | `#0B1220`, 18.72:1 | (canvas) | Primary text on light; the canvas of dark artwork |
| Paper | (canvas) | `#F8FAFC`, 18.09:1 | The canvas of light artwork; primary text on dark |
| Secondary | `#475569`, 7.58:1 | `#CBD5E1`, 12.75:1 | Secondary text, "Humans click." in the banners |
| Loss | `#B91C1C`, 6.47:1 | `#F87171`, 6.84:1 | Losses and errors only, never decoration |

Every pair above passes WCAG AA for body text. Don't swap themes: `#FACC15` on white is 1.53:1 and `#34D399` on
white is 1.92:1.

The logo's own colors are fixed and are not for text: tile gradient `#14857A` to `#0A5B54` with a faint white rim
and top highlight, bars `#FCD535` to `#F2BC0C` with a `#FEF3C7` top edge and a `#B7791F` base, favicon bars `#FDE047`
and `#EAB308`. The tile's edge keeps 3:1 or more against both GitHub backgrounds (3.27:1 against white, 3.04:1
against `#0D1117`, which is what the rim is for), and the bars keep 3:1 or more against the tile, the WCAG minimum
for graphics.

The web app's interface has its own tuned tokens in the same teal family (`apps/web/src/modes.css`); this palette is
for the logo, the README, docs and social images.

## Type

- **Geist** for interface and marketing text, **Geist Mono** for numbers and code. Both are by the Geist Project
  Authors (Vercel) under the SIL Open Font License 1.1, and the web app already self-hosts them
  (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`).
- The banners' tagline is Geist Regular converted to outlines, so it looks the same on every machine.
- `social-preview.svg` keeps live `<text>` with a fallback font stack; `render.mjs` loads Geist from `node_modules`
  when it makes the PNG.

## Do and don't

Do:

- Use the files as they are and scale them proportionally.
- Pick the variant for the background: "-light" on light, "-dark" on dark, or swap them with `<picture>` (below).
- Use `mark-mono.svg` when there's only one color, or when the background is close to the tile's teal.

Don't:

- Recolor the tile or the bars, add outlines, glows or extra shadows, rotate, skew or stretch anything.
- Rebuild the wordmark in a font, change its spacing, or set it in a color other than Ink or Paper (or one color for
  mono use).
- Put the full-color mark on a busy photo or a mid-teal background, crop its corners, or put it in another frame.
- Use a dark-theme color on a light background (or the reverse); see the ratios above.
- Use the logo to suggest that a fork, a service or another product is Holdr or is endorsed by it. Forks should have
  their own name and icon.

## Alt text

Keep alt text between 40 and 150 characters and lead with what it is ("Logo of…", "Screenshot of…").

| Asset | Alt text |
|---|---|
| Banner (both themes) | Logo of Holdr: a teal tile with two stacked gold bars forming an H, with the tagline “Humans click. Agents read.” |
| Lockup | Logo of Holdr: a teal tile with two stacked gold bars forming an H, followed by the word Holdr. |
| Mark, favicon, app icon | Logo of Holdr: a rounded teal tile with two stacked gold ingot bars that form the letter H. |
| Wordmark | Logo of Holdr: the word Holdr in rounded, geometric lettering. |
| Social preview | Logo of Holdr with the tagline “Humans click. Agents read.”, a demo net worth chart and a read-only MCP reply. |
| Screenshot (example) | Screenshot of the Holdr portfolio page in dark mode with demo accounts, holdings, gains and a performance chart. |
| Screenshot (example) | Screenshot of Holdr's card benefits page in dark mode, listing demo statement credits as reimbursed or unused. |

## Using the assets

**README hero.** GitHub picks the source that matches the reader's color scheme:

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/banner-light.svg">
    <img alt="Logo of Holdr: a teal tile with two stacked gold bars forming an H, with the tagline “Humans click. Agents read.”" src="docs/assets/brand/banner-light.svg">
  </picture>
</p>
```

Leave out `width` and `height`: GitHub scales the 1280 × 320 banner down to the page width.

**Favicons.** In a web page's `<head>`, with the files copied next to it (copy them; the privacy scan rejects
symbolic links):

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
```

Holdr's web app keeps identical copies in `apps/web/src/assets/brand/`, which Vite publishes as hashed release files;
update them together with these.

**GitHub social preview.** A repository admin uploads `docs/assets/brand/social-preview.png` under Settings → General →
Social preview. It is 1280 × 640 (GitHub's recommended size), opaque and under 1 MB, and keeps 64 px margins, so a
1.91:1 crop loses nothing.

## Screenshots

The README shows four screenshots of the demo, one per page: `docs/assets/screenshots/portfolio.png`, `gold.png`,
`spending.png` and `benefits.png`.

- **Demo data only.** Take every screenshot from the demo (`npm run demo`), never from your own data. No real names,
  account or card numbers (not even the last four digits), addresses, host names, file paths or e-mail addresses.
- **Dark theme, 1600 × 1000 pixels**, all at the same viewport and cropped to the app: no browser chrome, cursor,
  notifications, spinners or half-loaded charts.
- **PNG (or WebP) without metadata:** no text, EXIF, XMP, ICC profile or time chunks. The privacy scan refuses an image
  with any of them, and any image over 1 MB; aim for about 450 KB or less.
- **Location:** `docs/assets/screenshots/`, with lowercase, hyphenated names (`<page>.png`).
- **In the README:** an `<img>` with `width="100%"`, so that it fills its table cell, and alt text that starts with
  "Screenshot of…" and says it is dark mode, 40 to 150 characters ([Alt text](#alt-text)).
- **Before committing:** look at each one at 100 %, and run `npm run privacy:scan`.

Light and dark pairs of the same framing (`<page>-light.png` and `<page>-dark.png`, swapped with `<picture>` like the
banner) are possible future work; until then each page has one dark screenshot.

## Re-rendering the PNGs

The PNGs are generated from the SVGs by [`assets/brand/render.mjs`](assets/brand/render.mjs) with the repository's
own Playwright Chromium (the one the web app's end-to-end tests use). From the repository root, on Windows or macOS:

```sh
npm install                                                  # once: Playwright and the Geist fonts
node node_modules/@playwright/test/cli.js install chromium    # once per machine, if Chromium is missing
node docs/assets/brand/render.mjs                            # writes the four PNGs
node docs/assets/brand/render.mjs --check                    # fails if a PNG no longer matches its SVG
```

The output is deterministic: a fixed viewport and scale, the sRGB color profile, fonts from `node_modules`, no
network, and PNGs re-encoded without metadata. Text can rasterize slightly differently on another operating system,
so `--check` compares pixels, and only the social preview has text.

To change the art itself, edit the SVGs (all coordinates are absolute) and re-render:

- In `social-preview.svg`, text is live: edit it in place. Each chip's label has a `textLength` that keeps it inside
  its pill in other renderers; when you change a label, update that value and the pill's `width`, or remove the
  attribute.
- The banners' tagline is outlined Geist Regular, 34 px, letter spacing −0.3 px, its left edge on the wordmark's left
  edge. To change it, set the new text in those settings in a vector editor, convert it to outlines, and replace the
  two tagline paths.

## Trademarks and advice

Holdr is an independent open-source project. Card issuers, banks, brokerages, retailers and data providers named in
this repository are trademarks of their respective owners; Holdr is not affiliated with, endorsed by or sponsored by
any of them. Holdr and its documentation are not financial, investment, tax or legal advice.
