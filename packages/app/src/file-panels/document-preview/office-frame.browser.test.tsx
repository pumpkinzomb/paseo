import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OfficeFrame, sanitizedOfficeHtml } from "./office-frame.web";
let cleanup = () => {};
afterEach(() => cleanup());
it("removes active markup and outbound navigation without flattening cell formatting", () => {
  const html = sanitizedOfficeHtml(
    `<script>throw 1</script><meta http-equiv="refresh" content="0;url=https://evil.test"><iframe src="https://evil.test"></iframe><table><tr><td colspan="3" style="background:#2458a6;width:150px" onclick="alert(1)">24000</td></tr></table><a href="https://evil.test" onmouseover="alert(2)">link</a><img src="https://evil.test/image" srcset="https://evil.test/x 2x">`,
  );
  const node = document.createElement("template");
  node.innerHTML = html;
  expect(node.content.querySelector("script,meta,iframe")).toBeNull();
  expect(node.content.querySelector("td")?.getAttribute("colspan")).toBe("3");
  expect(node.content.querySelector("td")?.getAttribute("style")).toContain("#2458a6");
  expect(node.content.querySelector("td")?.getAttribute("onclick")).toBeNull();
  expect(node.content.querySelector("a")?.getAttributeNames()).toEqual([]);
  expect(node.content.querySelector("img")?.getAttributeNames()).toEqual([]);
});
it("renders an opaque sandbox and updates the actual sheet payload and zoom", () => {
  vi.stubGlobal("React", React);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  act(() => root.render(<OfficeFrame html="<table><tr><td>Summary 24000</td></tr></table>" />));
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(decodeURIComponent(frame.getAttribute("src")!)).toContain("Summary 24000");
  act(() =>
    root.render(<OfficeFrame html="<table><tr><td>Detail 1234</td></tr></table>" zoom={1.5} />),
  );
  const source = decodeURIComponent(frame.getAttribute("src")!);
  expect(source).toContain("Detail 1234");
  expect(source).not.toContain("Summary 24000");
  expect(source).toContain("zoom:1.5");
  expect(source).toContain("script-src 'none'");
});
