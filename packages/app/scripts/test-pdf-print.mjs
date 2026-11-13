import { createPdfFixture as fixture } from "./pdf-preview-fixture.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const lab = path.join(root, ".lab/pdf-print");
await fs.mkdir(lab, { recursive: true });
await build({
  entryPoints: [path.join(root, "packages/app/src/file-panels/pdf-viewer/runtime/html.gen.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(lab, "runtime.mjs"),
  logLevel: "silent",
});
const { pdfRuntimeHtml, pdfRuntimeVersion } = await import(
  pathToFileURL(path.join(lab, "runtime.mjs"))
);
assert.equal(pdfRuntimeVersion, "6.5.438");
const fixturePath = path.join(root, ".lab/pdf-print-fixture.pdf");
const bytes = Buffer.from(fixture(), "base64");
await fs.writeFile(fixturePath, bytes);
const labels = {
  loading: "Loading",
  failed: "Failed",
  toggle: "Thumbnails",
  resize: "Resize",
  previous: "Previous",
  next: "Next",
  page: "Page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  fitWidth: "Fit width",
  openOriginal: "Original",
  password: "Password",
  printPreparing: "Preparing print",
  printFailed: "Print failed",
  printTooLarge: "Print too large",
};
const bridge = `<script>window.events=[];window.printCalls=0;window.print=()=>{window.printCalls++};window.addEventListener('message',e=>{if(e.source!==window)return;window.events.push(e.data);if(e.data.type==='pdf-ready'){const data=Uint8Array.from(atob(${JSON.stringify(bytes.toString("base64"))}),c=>c.charCodeAt(0)).buffer;window.postMessage({type:'pdf-load',bytes:data,preferences:{width:110,collapsed:false},labels:${JSON.stringify(labels)},dark:false},'*',[data]);}});</script>`;
const html = pdfRuntimeHtml.replace("</head>", `${bridge}</head>`);
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("No local port");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => window.events.some((e) => e.type === "pdf-rendered"));
  assert.equal(await page.evaluate(() => window.printCalls), 0, "No printing on file load");
  await page.evaluate(() => window.postMessage({ type: "pdf-print" }, "*"));
  await page.waitForFunction(() => window.printCalls === 1, { timeout: 30000 });
  assert.equal(await page.locator(".pdf-print-page").count(), 3);
  await page.emulateMedia({ media: "print" });
  const printed = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await fs.writeFile(path.join(lab, "printed.pdf"), printed);
  const require = createRequire(import.meta.url);
  const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")));
  const task = pdfjs.getDocument({ data: new Uint8Array(printed) });
  const result = await task.promise;
  assert.equal(result.numPages, 3, "All pages, not only visible viewer pages");
  const second = (await result.getPage(2)).getViewport({ scale: 1 });
  assert(second.width > second.height, "Landscape print orientation retained");
  await task.destroy();
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await page.waitForFunction(() => !document.querySelector("#pdf-print-root"));
  assert(
    await page.evaluate(() =>
      window.events.some((e) => e.type === "pdf-print-state" && e.busy === false),
    ),
  );
  console.log(
    JSON.stringify(
      {
        printedPages: 3,
        orientationRetained: true,
        automaticPrintOnLoad: false,
        cleanup: true,
        physicalPrinterUsed: false,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
