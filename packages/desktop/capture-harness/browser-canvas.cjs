const { app, BrowserWindow, webContents } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const out = process.env.PASEO_CANVAS_TEST_OUT;
if (!out) throw Error("Use check-browser-canvas.mjs so state and output stay in the lab");
app.setPath("userData", path.join(out, "user-data"));
if (process.platform === "darwin") app.setActivationPolicy("accessory");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = setTimeout(() => {
  console.error("Canvas test timed out");
  app.exit(1);
}, 30000);
function pixel(image) {
  const data = image.toBitmap();
  const offset = (50 * image.getSize().width + 50) * 4;
  return [data[offset + 2], data[offset + 1], data[offset], data[offset + 3]];
}
app.whenReady().then(async () => {
  let win;
  const server = http.createServer((request, response) => {
    const style =
      request.url === "/dark"
        ? "html,body{background:rgb(20,40,60);color:white}"
        : request.url === "/scheme-dark"
          ? "html{color-scheme:dark}"
          : "";
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><html><head><style>html,body{margin:0;min-height:100%}${style}</style></head><body>Readable page text</body></html>`,
    );
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + server.address().port;
    // Never show a window or take the user's focus. capturePage requests paint.
    win = new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      backgroundColor: "#181818",
      webPreferences: {
        webviewTag: true,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    const bundle = fs.readFileSync(path.join(out, "resident-webviews.js"), "utf8");
    const host = `<!doctype html><html><body style="margin:0;background:#181818"><div id="clip" style="width:640px;height:480px;display:flex"><div id="anchor" style="display:flex;flex:1"></div></div><script>${bundle}</script></body></html>`;
    fs.writeFileSync(path.join(out, "host.html"), host);
    await win.loadFile(path.join(out, "host.html"));
    await win.webContents.executeJavaScript(`(() => {
      const h=window.BrowserCanvasHarness;
      const guest=h.ensureResidentBrowserWebview({browserId:'canvas',workspaceId:'fixture',url:${JSON.stringify(origin + "/transparent")},profileHost:{profilePartition:'persist:canvas-test',registerAttachedBrowser:async()=>{}}});
      h.presentBrowserWebview('canvas',guest,document.getElementById('anchor'),document.getElementById('clip'),{mode:'responsive'});
    })()`);
    let guest;
    for (let i = 0; i < 100; i++) {
      try {
        const id = await win.webContents.executeJavaScript(
          `document.querySelector('webview').getWebContentsId()`,
        );
        guest = webContents.fromId(id);
        if (guest && !guest.isLoading()) break;
      } catch {}
      await delay(50);
    }
    assert.ok(guest, "Guest must attach");
    const checks = [];
    async function check(name, expected) {
      // Reparenting can recreate Electron's native guest without changing the DOM
      // element. Resolve the current identity, just as production registration does.
      for (let i = 0; i < 100; i++) {
        try {
          const id = await win.webContents.executeJavaScript(
            `document.querySelector('webview').getWebContentsId()`,
          );
          guest = webContents.fromId(id);
          if (guest && !guest.isDestroyed() && !guest.isLoading()) break;
        } catch {}
        await delay(50);
      }
      await delay(150);
      const hostImage = await win.webContents.capturePage();
      const guestImage = await guest.capturePage();
      const actual = pixel(hostImage);
      const guestPixel = pixel(guestImage);
      fs.writeFileSync(path.join(out, name + ".png"), hostImage.toPNG());
      assert.deepEqual(actual, expected, name + " visible canvas");
      assert.deepEqual(guestPixel, expected, name + " browser screenshot canvas");
      checks.push({ name, hostPixel: actual, guestPixel });
      console.log("PASS", name, JSON.stringify(actual));
    }
    await check("transparent-default-white", [255, 255, 255, 255]);
    await guest.loadURL(origin + "/dark");
    await check("site-dark-background-preserved", [20, 40, 60, 255]);
    await guest.loadURL(origin + "/scheme-dark");
    await check("site-color-scheme-dark-preserved", [18, 18, 18, 255]);
    await guest.loadURL(origin + "/transparent");
    await win.webContents.executeJavaScript(
      `(() => {const h=BrowserCanvasHarness,g=document.querySelector('webview');h.releaseResidentBrowserWebview('canvas',g);h.presentBrowserWebview('canvas',g,document.getElementById('anchor'),document.getElementById('clip'),{mode:'responsive'});})()`,
    );
    await check("white-after-navigation-and-representation", [255, 255, 255, 255]);
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(checks, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    win?.destroy();
    server.close();
    app.exit(process.exitCode || 0);
  }
});
