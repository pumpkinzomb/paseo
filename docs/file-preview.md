# Document file preview

File cards open in the existing Explorer dock. They do not create another main pane. Documents,
workbooks and the browser share its tab rail; ordinary code editing retains its existing placement.

## PDF viewer (web and desktop)

`file-panels/document-frame/index.web.tsx` classifies the local file Blob by MIME type. PDFs use the
app-owned PDF.js viewer, not Chromium's fixed-width internal PDF UI. Other types keep the fully
sandboxed frame. The native adapter is unchanged; mobile device QA is not claimed.

- Page thumbnails start at **110 px**, with a **72–240 px** user range. Pointer capture supports
  dragging; cancellation restores the initial width. Arrow keys resize by 8 px (Shift: 20), Home/End
  choose the limits, and double-click restores 110 px.
- The toggle collapses thumbnails. Narrow containers under 360 px hide them without overwriting the
  stored preference; resizing wider restores them. Width/collapse are device-local preferences, not
  document content. Source-checked iframe messages and validated values form the persistence boundary.
- The body starts in fit-width mode, including mixed landscape/portrait pages. Page input, previous/next,
  zoom and selectable text are available. Visible pages and thumbnails render lazily; offscreen bitmap
  memory is released. Canvas dimensions/pixel counts and document size/page count are bounded.
- Source changes clear prior pages, cancel earlier work and ignore stale completion. Invalid,
  unsupported or password-protected files show an error and offer the original browser viewer.
  Full Acrobat features, editing, annotation actions, PDF form scripting and print UI are not provided.

PDF.js core, matching parser Worker, CMaps, fonts and image-decoder WASM assets are bundled locally by
`npm run build:pdf-runtime`, included in app dependency builds. No runtime CDN, cloud upload, OAuth
transfer or browser account login is involved. Worker parsing is retained; drawing occurs within the
isolated viewer frame, with library cooperative rendering. The optional new renderer-worker API is
explicitly disabled. Native canvas dependencies are not used by this browser runtime.

The opaque iframe permits only its bundled script, local Blob Worker/fonts/images and decoder WASM.
It has no same-origin capability, remote connect permission, PDF scripting engine, navigation or form
execution. Raw PDF bytes cross the bridge as a transferred ArrayBuffer. The host accepts preference
messages only from that iframe. PDF text is rendered through the library's text layer, not raw HTML.

The initial 5.x candidate was rejected after npm's public advisory API reported
`GHSA-hq66-cqwq-w95j`. The exact fixed dependency is **pdfjs-dist 6.5.438**; generated runtime version is
checked against the installed package before browser tests so an old bundle cannot pass validation.
Bundled third-party code retains its Apache-2.0 licensing notices.

## Verification

`npm run test:pdf-viewer` generates the engine and runs an isolated localhost Playwright harness with
synthetic PDF files. It checks real page/text rendering, resizing, keyboard control, collapse,
restoration, mixed page orientation, damaged file recovery, rapid source changes, lazy rendering of an
80-page document, offscreen bitmap disposal, no external requests and non-execution of a PDF OpenAction.
It writes screenshots/logs only under `.lab/pdf-browser`. App Vitest browser tests additionally check
actual DocumentFrame routing, host persistence/source validation, error recovery and non-PDF isolation.

Spreadsheet previews keep the existing read-only sheet tabs and Office renderer. PPT/PPTX preview is
not implemented by this PDF change; its future slide viewer is separate work.
