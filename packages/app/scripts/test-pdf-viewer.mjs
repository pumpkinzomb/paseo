import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lab = path.resolve(appRoot, "../../.lab/pdf-browser");
await fs.mkdir(lab, { recursive: true });
await build({
  entryPoints: [path.join(appRoot, "src/file-panels/pdf-viewer/runtime/html.gen.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(lab, "runtime.mjs"),
  logLevel: "silent",
});
const { pdfRuntimeHtml, pdfRuntimeVersion } = await import(
  pathToFileURL(path.join(lab, "runtime.mjs"))
);
const require = createRequire(import.meta.url);
const installedVersion = JSON.parse(
  await fs.readFile(require.resolve("pdfjs-dist/package.json")),
).version;
assert.equal(pdfRuntimeVersion, installedVersion, "Stale PDF runtime: rebuild before testing");
function fixture(count = 3) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert('must-not-run')) >> >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${count} >>`,
  ];
  for (let page = 1; page <= count; page++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page === 2 ? "842 595" : "595 842"}] /Resources << /Font << /F1 ${count + 3} 0 R >> >> /Contents ${count + 3 + page} 0 R >>`,
    );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= count; page++) {
    const top = page === 2 ? 450 : 700;
    const text = `0.15 0.35 0.65 rg 40 ${top - 70} 515 150 re f BT /F1 26 Tf 1 1 1 rg 65 ${top} Td (PDF Preview Page ${page}) Tj ET BT /F1 16 Tf 0 0 0 rg 65 ${top - 140} Td (Readable original file, not a text reconstruction.) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}
const labels = {
  loading: "Loading PDF",
  failed: "PDF failed",
  toggle: "Toggle thumbnails",
  resize: "Resize thumbnails",
  previous: "Previous",
  next: "Next",
  page: "Page",
  zoomOut: "Zoom out",
  zoomIn: "Zoom in",
  fitWidth: "Fit width",
  openOriginal: "Original",
  password: "Password required",
};
const harness = `<!doctype html><style>html,body{margin:0;height:100%;background:#171a1a}iframe{border:0;width:100%;height:100%}</style><iframe title="PDF" sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');window.events=[];window.saved={width:110,collapsed:false};
function send(bytes){frame.contentWindow.postMessage({type:'pdf-load',bytes,preferences:window.saved,labels:${JSON.stringify(labels)},dark:true},'*',[bytes]);}
window.loadLong=()=>{const raw=atob(${JSON.stringify(fixture(80))});send(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer)};
window.loadInvalid=()=>send(new TextEncoder().encode('not a PDF').buffer);
window.clearPDF=()=>frame.contentWindow.postMessage({type:'pdf-reset'},'*');
window.reloadPDF=()=>{const raw=atob(${JSON.stringify(fixture())});send(Uint8Array.from(raw,c=>c.charCodeAt(0)).buffer)};
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;window.events.push(event.data);if(event.data.type==='pdf-ready')window.reloadPDF();if(event.data.type==='pdf-preferences')window.saved=event.data.preferences;});
frame.srcdoc=${JSON.stringify(pdfRuntimeHtml).replace(/<\/script/gi, "<\\/script")};
</script>`;
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(harness);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("No local port");
const browser = await chromium.launch({ headless: true });
let assertions = 0;
try {
  const page = await browser.newPage({ viewport: { width: 646, height: 700 } });
  const errors = [],
    network = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => {
    errors.push(`Unexpected PDF JavaScript: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("request", (request) => {
    if (
      !request.url().startsWith(`http://127.0.0.1:${address.port}`) &&
      !request.url().startsWith("blob:") &&
      !request.url().startsWith("data:")
    )
      network.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const frame = page.frameLocator("iframe");
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor({ timeout: 30000 });
  assertions++;
  assert.equal(
    await frame
      .locator("#thumbnails")
      .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
    110,
  );
  assertions++;
  const bodyWidth = await frame.locator("#pages").evaluate((node) => node.clientWidth);
  assert(bodyWidth >= 520);
  assertions++;
  assert(
    await frame
      .locator('.pdf-page[data-page="1"] .textLayer')
      .innerText()
      .then((text) => text.includes("PDF Preview Page 1")),
  );
  assertions++;
  assert.equal(await frame.locator("#fit").innerText(), "Fit width");
  assertions++;
  const divider = frame.locator("#divider");
  const box = await divider.boundingBox();
  if (!box) throw Error("Missing divider");
  await page.mouse.move(box.x + 3, box.y + 70);
  await page.mouse.down();
  await page.mouse.move(box.x + 63, box.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => window.saved.width === 170);
  assertions++;
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => window.saved.width === 162);
  assertions++;
  await page.keyboard.press("Home");
  await page.waitForFunction(() => window.saved.width === 72);
  assertions++;
  await divider.dblclick();
  await page.waitForFunction(() => window.saved.width === 110);
  assertions++;
  await frame.locator("#toggle").click();
  assert.equal(await frame.locator("#thumbnails").isVisible(), false);
  assertions++;
  assert((await frame.locator("#pages").evaluate((node) => node.clientWidth)) > bodyWidth);
  assertions++;
  await frame.locator("#toggle").click();
  await frame.locator("#next").click();
  await frame.locator('.pdf-page[data-page="2"][data-rendered="true"]').waitFor();
  assertions++;
  assert.equal(await frame.locator("#page").inputValue(), "2");
  assertions++;
  const landscape = frame.locator('.pdf-page[data-page="2"]');
  const landscapeBox = await landscape.boundingBox();
  assert(landscapeBox && landscapeBox.width > landscapeBox.height);
  assertions++;
  assert.equal(
    await frame.locator("#pages").evaluate((node) => node.scrollWidth),
    await frame.locator("#pages").evaluate((node) => node.clientWidth),
  );
  assertions++;
  await page.screenshot({ path: path.join(lab, "pdf-landscape.png") });
  await frame.locator("#zoom-in").click();
  await frame.locator("#fit").click();
  assertions++;
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => window.saved.width === 118);
  await page.evaluate(() => window.reloadPDF());
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor();
  assert.equal(await divider.getAttribute("aria-valuenow"), "118");
  assertions++;
  await page.setViewportSize({ width: 320, height: 700 });
  await page.waitForTimeout(150);
  assert.equal(await frame.locator("#thumbnails").isVisible(), false);
  assertions++;
  await page.setViewportSize({ width: 646, height: 700 });
  await page.waitForTimeout(150);
  assert.equal(await divider.getAttribute("aria-valuenow"), "118");
  assertions++;
  await page.screenshot({ path: path.join(lab, "pdf-viewer.png") });
  assert.deepEqual(network, []);
  assertions++;
  assert.deepEqual(errors, []);
  assertions++;
  await page.evaluate(() => window.clearPDF());
  assert.equal(await frame.locator(".pdf-page").count(), 0);
  assertions++;
  await page.evaluate(() => window.loadInvalid());
  await frame.locator("#status").filter({ hasText: "PDF failed" }).waitFor();
  assertions++;
  await page.evaluate(() => window.reloadPDF());
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor();
  assertions++;
  await page.evaluate(() => {
    window.loadInvalid();
    window.reloadPDF();
  });
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor();
  assert.equal(await frame.locator("#status").innerText(), "");
  assertions++;
  await frame.locator("#toggle").click();
  await page.evaluate(() => window.reloadPDF());
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor();
  assert.equal(await frame.locator("#thumbnails").isVisible(), false);
  assertions++;
  await frame.locator("#toggle").click();
  await page.evaluate(() => window.loadLong());
  await frame.locator('.pdf-page[data-page="1"][data-rendered="true"]').waitFor();
  assert.equal(await frame.locator(".pdf-page").count(), 80);
  assertions++;
  assert(
    (await frame
      .locator("canvas")
      .evaluateAll((nodes) => nodes.filter((node) => node.width > 0).length)) < 20,
  );
  assertions++;
  await frame.locator("#page").fill("80");
  await frame.locator("#page").press("Enter");
  await frame.locator("#page").blur();
  await frame.locator('.pdf-page[data-page="80"][data-rendered="true"]').waitFor();
  await page.waitForTimeout(200);
  assert.equal(
    await frame.locator('.pdf-page[data-page="1"] canvas').evaluate((node) => node.width),
    0,
  );
  assertions++;
  assert.deepEqual(network, []);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        assertions,
        pdfRuntimeVersion,
        realPdfRendered: true,
        pdfScriptExecuted: false,
        externalNetworkRequests: network.length,
        screenshot: path.join(lab, "pdf-viewer.png"),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
