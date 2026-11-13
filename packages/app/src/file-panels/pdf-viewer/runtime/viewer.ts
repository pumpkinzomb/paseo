import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import {
  DEFAULT_PDF_PREFERENCES,
  effectiveThumbnailWidth,
  parsePdfPreferences,
  thumbnailWidth,
  type PdfViewerLabels,
  type PdfViewerPreferences,
} from "../model";

declare const __PDF_WORKER__: string;
declare const __PDF_ASSETS__: Record<string, string>;
function asset(name: string): Uint8Array {
  const encoded = __PDF_ASSETS__[name];
  if (!encoded) throw new Error("Missing bundled PDF resource");
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
class BundledBinaryData {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const directories: Record<string, string> = {
      cMapUrl: "cmaps",
      standardFontDataUrl: "standard_fonts",
      wasmUrl: "wasm",
    };
    const directory = directories[kind];
    if (!directory || filename.includes("/") || filename.includes(".."))
      throw new Error("Unsupported PDF resource");
    return asset(`${directory}/${filename}`);
  }
}
export interface ViewerBridge {
  send(message: unknown): void;
}
interface PageView {
  node: HTMLElement;
  canvas: HTMLCanvasElement;
  text: HTMLDivElement;
  task: RenderTask | null;
  layer: TextLayer | null;
  visible: boolean;
  revision: number;
}
export function createPdfViewer(root: HTMLElement, bridge: ViewerBridge) {
  let preferences = { ...DEFAULT_PDF_PREFERENCES };
  let labels: PdfViewerLabels;
  let pdf: PDFDocumentProxy | null = null;
  let loading: ReturnType<typeof getDocument> | null = null;
  let disposed = false;
  let generation = 0;
  let scale: number | "width" = "width";
  let pageNumber = 1;
  let firstWidth = 595,
    firstHeight = 842;
  let workerUrl: string | null = null;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  const views = new Map<HTMLElement, PageView>();
  root.innerHTML = `<div class="pdf-toolbar"><button id="toggle">☰</button><button id="previous">‹</button><input id="page" type="number" min="1" value="1"><span id="count"></span><button id="next">›</button><span class="toolbar-gap"></span><button id="zoom-out">−</button><span id="zoom"></span><button id="zoom-in">+</button><button id="fit"></button></div><div class="pdf-workspace"><nav id="thumbnails"></nav><div id="divider" role="separator" aria-orientation="vertical" tabindex="0"></div><main id="pages" tabindex="0"></main><div id="status" role="status"></div></div>`;
  function element<T extends HTMLElement>(id: string): T {
    const node = root.querySelector<T>(`#${id}`);
    if (!node) throw new Error("PDF viewer structure is missing");
    return node;
  }
  const main = element<HTMLElement>("pages");
  const thumbnails = element<HTMLElement>("thumbnails");
  const divider = element<HTMLElement>("divider");
  const pageInput = element<HTMLInputElement>("page");
  const status = element<HTMLElement>("status");
  const eventLifetime = new AbortController();
  const events = { signal: eventLifetime.signal };
  function announce(type: string) {
    bridge.send({
      type,
      pages: pdf?.numPages ?? 0,
      page: pageNumber,
      width: effectiveThumbnailWidth(preferences, root.clientWidth),
      bodyWidth: main.clientWidth,
    });
  }
  function save() {
    bridge.send({ type: "pdf-preferences", preferences });
  }
  function currentScale() {
    if (scale !== "width") return scale;
    const page = main.querySelector<HTMLElement>(`[data-page="${pageNumber}"]`);
    const width =
      Number.parseFloat(page?.style.getPropertyValue("--intrinsic-width") ?? "") || firstWidth;
    return Math.max(1, main.clientWidth - 32) / width;
  }
  function cancel(view: PageView) {
    view.revision += 1;
    view.task?.cancel();
    view.task = null;
    view.layer?.cancel();
    view.layer = null;
  }
  function clearBitmap(view: PageView) {
    cancel(view);
    view.canvas.width = 0;
    view.canvas.height = 0;
    view.text.replaceChildren();
  }
  async function paint(view: PageView) {
    const document = pdf;
    if (!document || !view.visible || disposed) return;
    cancel(view);
    const revision = view.revision;
    const documentGeneration = generation;
    const current = () =>
      !disposed && generation === documentGeneration && revision === view.revision && view.visible;
    let page: PDFPageProxy;
    try {
      page = await document.getPage(Number(view.node.dataset.page));
      if (!current()) return;
      const thumbnail = view.node.dataset.thumbnail === "true";
      const base = page.getViewport({ scale: 1 });
      let factor = currentScale();
      if (thumbnail) factor = Math.max(0.05, (thumbnails.clientWidth - 24) / base.width);
      else if (scale === "width") factor = Math.max(1, main.clientWidth - 32) / base.width;
      const viewport = page.getViewport({ scale: factor });
      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        16384 / viewport.width,
        16384 / viewport.height,
      );
      if (thumbnail) {
        view.node.style.width = `${viewport.width}px`;
        view.node.style.height = `${viewport.height}px`;
      } else {
        view.node.style.setProperty("--intrinsic-width", `${base.width}px`);
        view.node.style.setProperty("--intrinsic-height", `${base.height}px`);
        view.node.style.setProperty("--intrinsic-ratio", `${base.width} / ${base.height}`);
      }
      view.node.style.setProperty("--scale-factor", String(factor));
      view.node.style.setProperty("--total-scale-factor", String(factor));
      view.canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      view.canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      view.canvas.style.width = "100%";
      view.canvas.style.height = "100%";
      view.task = page.render({
        canvas: view.canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await view.task.promise;
      if (!current()) return;
      if (!thumbnail) {
        const text = await page.getTextContent();
        if (!current()) return;
        view.text.replaceChildren();
        view.layer = new TextLayer({ textContentSource: text, container: view.text, viewport });
        await view.layer.render();
      }
      if (!current()) return;
      view.node.dataset.rendered = "true";
      if (!thumbnail) {
        element("zoom").textContent = `${Math.round(currentScale() * 100)}%`;
        announce("pdf-rendered");
      }
    } catch {
      if (current()) {
        view.node.dataset.error = "true";
        status.textContent = labels.failed;
        bridge.send({ type: "pdf-error" });
      }
    }
  }
  function schedulePaint() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      for (const view of views.values()) if (view.visible) void paint(view);
    }, 100);
  }
  function layout() {
    const width = effectiveThumbnailWidth(preferences, root.clientWidth);
    root.style.setProperty("--thumbnail-width", `${width}px`);
    element<HTMLButtonElement>("toggle").disabled = root.clientWidth < 360;
    thumbnails.hidden = width === 0;
    divider.hidden = width === 0;
    divider.setAttribute("aria-valuemin", "72");
    divider.setAttribute("aria-valuemax", "240");
    divider.setAttribute("aria-valuenow", String(preferences.width));
    element("toggle").setAttribute("aria-expanded", String(width > 0));
    const factor = currentScale();
    element("zoom").textContent = `${Math.round(factor * 100)}%`;
    root.style.setProperty("--page-scale", String(factor));
    root.style.setProperty("--fit-width", `${Math.max(1, main.clientWidth - 32)}px`);
    root.dataset.fit = String(scale === "width");
    schedulePaint();
  }
  const mainObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const view = views.get(entry.target as HTMLElement);
        if (!view) continue;
        view.visible = entry.isIntersecting;
        if (view.visible) void paint(view);
        else clearBitmap(view);
      }
    },
    { root: main, rootMargin: "400px 0px" },
  );
  const thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const view = views.get(entry.target as HTMLElement);
        if (!view) continue;
        view.visible = entry.isIntersecting;
        if (view.visible) void paint(view);
        else clearBitmap(view);
      }
    },
    { root: thumbnails, rootMargin: "100px 0px" },
  );
  function selectPage(value: number, scroll: boolean) {
    if (!pdf) return;
    pageNumber = Math.max(1, Math.min(pdf.numPages, Math.round(value) || 1));
    pageInput.value = String(pageNumber);
    element("zoom").textContent = `${Math.round(currentScale() * 100)}%`;
    const previous = thumbnails.querySelector('[aria-current="page"]');
    const selected = thumbnails.querySelector(`[data-page="${pageNumber}"]`);
    if (previous !== selected) {
      previous?.setAttribute("aria-current", "false");
      selected?.setAttribute("aria-current", "page");
    }
    if (scroll)
      main
        .querySelector<HTMLElement>(`[data-page="${pageNumber}"]`)
        ?.scrollIntoView({ block: "start" });
  }
  function addPage(number: number, thumbnail: boolean) {
    const wrapper = document.createElement(thumbnail ? "button" : "section");
    wrapper.dataset.page = String(number);
    wrapper.dataset.thumbnail = String(thumbnail);
    wrapper.className = thumbnail ? "pdf-thumbnail" : "pdf-page";
    wrapper.setAttribute("aria-label", `${labels.page} ${number}`);
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const text = document.createElement("div");
    text.className = "textLayer";
    wrapper.append(canvas, text);
    const view: PageView = {
      node: wrapper,
      canvas,
      text,
      task: null,
      layer: null,
      visible: false,
      revision: 0,
    };
    views.set(wrapper, view);
    if (thumbnail) {
      const label = document.createElement("span");
      label.className = "thumbnail-number";
      label.textContent = String(number);
      wrapper.append(label);
      wrapper.addEventListener("click", () => selectPage(number, true), events);
      thumbnails.append(wrapper);
      thumbObserver.observe(wrapper);
    } else {
      wrapper.style.setProperty("--intrinsic-width", `${firstWidth}px`);
      wrapper.style.setProperty("--intrinsic-height", `${firstHeight}px`);
      wrapper.style.setProperty("--intrinsic-ratio", `${firstWidth} / ${firstHeight}`);
      main.append(wrapper);
      mainObserver.observe(wrapper);
    }
  }
  element("toggle").addEventListener(
    "click",
    () => {
      preferences = { ...preferences, collapsed: !preferences.collapsed };
      layout();
      save();
    },
    events,
  );
  element("previous").addEventListener("click", () => selectPage(pageNumber - 1, true), events);
  element("next").addEventListener("click", () => selectPage(pageNumber + 1, true), events);
  pageInput.addEventListener("change", () => selectPage(Number(pageInput.value), true), events);
  element("zoom-out").addEventListener(
    "click",
    () => {
      scale = Math.max(0.1, currentScale() - 0.1);
      layout();
    },
    events,
  );
  element("zoom-in").addEventListener(
    "click",
    () => {
      scale = Math.min(4, currentScale() + 0.1);
      layout();
    },
    events,
  );
  element("fit").addEventListener(
    "click",
    () => {
      scale = "width";
      layout();
    },
    events,
  );
  let drag: { pointer: number; x: number; width: number; start: number } | null = null;
  divider.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = {
        pointer: event.pointerId,
        x: event.clientX,
        width: preferences.width,
        start: effectiveThumbnailWidth(preferences, root.clientWidth),
      };
      divider.setPointerCapture(event.pointerId);
      root.classList.add("resizing");
    },
    events,
  );
  divider.addEventListener(
    "pointermove",
    (event) => {
      if (!drag || drag.pointer !== event.pointerId) return;
      preferences = { ...preferences, width: thumbnailWidth(drag.start + event.clientX - drag.x) };
      layout();
    },
    events,
  );
  function stopDrag(commit: boolean) {
    if (!drag) return;
    if (!commit) preferences = { ...preferences, width: drag.width };
    const pointer = drag.pointer;
    drag = null;
    if (divider.hasPointerCapture(pointer)) divider.releasePointerCapture(pointer);
    root.classList.remove("resizing");
    layout();
    if (commit) save();
  }
  divider.addEventListener("pointerup", () => stopDrag(true), events);
  divider.addEventListener("pointercancel", () => stopDrag(false), events);
  divider.addEventListener("lostpointercapture", () => stopDrag(false), events);
  divider.addEventListener(
    "dblclick",
    () => {
      preferences = { ...preferences, width: 110 };
      layout();
      save();
    },
    events,
  );
  divider.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        stopDrag(false);
        return;
      }
      const delta = event.shiftKey ? 20 : 8;
      const widths: Record<string, number> = {
        ArrowLeft: preferences.width - delta,
        ArrowRight: preferences.width + delta,
        Home: 72,
        End: 240,
      };
      const width = widths[event.key] ?? null;
      if (width === null) return;
      event.preventDefault();
      preferences = { ...preferences, width: thumbnailWidth(width) };
      layout();
      save();
    },
    events,
  );
  main.addEventListener(
    "scroll",
    () => {
      const top = main.getBoundingClientRect().top;
      let nearest: HTMLElement | null = null,
        distance = Infinity;
      for (const view of views.values())
        if (view.visible && view.node.dataset.thumbnail !== "true") {
          const next = Math.abs(view.node.getBoundingClientRect().top - top);
          if (next < distance) {
            nearest = view.node;
            distance = next;
          }
        }
      if (nearest) selectPage(Number(nearest.dataset.page), false);
    },
    events,
  );
  const resize = new ResizeObserver(layout);
  resize.observe(root);
  async function load(
    bytes: ArrayBuffer,
    initial: PdfViewerPreferences,
    text: PdfViewerLabels,
    dark: boolean,
  ) {
    const revision = ++generation;
    labels = text;
    preferences = parsePdfPreferences(initial) ?? { ...DEFAULT_PDF_PREFERENCES };
    scale = "width";
    root.classList.toggle("dark", dark);
    for (const [id, key] of [
      ["toggle", "toggle"],
      ["previous", "previous"],
      ["next", "next"],
      ["zoom-out", "zoomOut"],
      ["zoom-in", "zoomIn"],
      ["fit", "fitWidth"],
    ] as const)
      element(id).setAttribute("aria-label", labels[key]);
    element("fit").textContent = labels.fitWidth;
    pageInput.setAttribute("aria-label", labels.page);
    divider.setAttribute("aria-label", labels.resize);
    for (const view of views.values()) clearBitmap(view);
    views.clear();
    mainObserver.disconnect();
    thumbObserver.disconnect();
    main.replaceChildren();
    thumbnails.replaceChildren();
    pdf = null;
    status.textContent = labels.loading;
    const old = loading;
    loading = null;
    await old?.destroy();
    if (disposed || revision !== generation) return;
    workerUrl ??= URL.createObjectURL(new Blob([__PDF_WORKER__], { type: "text/javascript" }));
    GlobalWorkerOptions.workerSrc = workerUrl;
    try {
      const task = getDocument({
        data: new Uint8Array(bytes),
        useWasm: true,
        useWorkerFetch: false,
        disableWorkerRendering: true,
        BinaryDataFactory: BundledBinaryData,
        disableAutoFetch: true,
        stopAtErrors: true,
      });
      loading = task;
      task.onPassword = () => {
        if (disposed || revision !== generation) return;
        status.textContent = labels.password;
        bridge.send({ type: "pdf-error" });
        void task.destroy();
      };
      const document = await task.promise;
      if (disposed || revision !== generation) return;
      if (document.numPages > 2000) throw Error("Too many pages");
      pdf = document;
      const first = await document.getPage(1);
      if (disposed || revision !== generation) return;
      const viewport = first.getViewport({ scale: 1 });
      firstWidth = viewport.width;
      firstHeight = viewport.height;
      for (let number = 1; number <= document.numPages; number++) {
        addPage(number, false);
        addPage(number, true);
      }
      element("count").textContent = `/ ${document.numPages}`;
      pageInput.max = String(document.numPages);
      status.textContent = "";
      selectPage(1, false);
      layout();
      announce("pdf-loaded");
    } catch {
      if (!disposed && revision === generation) {
        if (status.textContent !== labels.password) status.textContent = labels.failed;
        bridge.send({ type: "pdf-error" });
      }
    }
  }
  function reset() {
    generation += 1;
    for (const view of views.values()) clearBitmap(view);
    views.clear();
    mainObserver.disconnect();
    thumbObserver.disconnect();
    main.replaceChildren();
    thumbnails.replaceChildren();
    pdf = null;
    status.textContent = labels?.loading ?? "";
    const task = loading;
    loading = null;
    void task?.destroy();
  }
  function destroy() {
    disposed = true;
    generation += 1;
    eventLifetime.abort();
    clearTimeout(repaintTimer);
    resize.disconnect();
    mainObserver.disconnect();
    thumbObserver.disconnect();
    for (const view of views.values()) clearBitmap(view);
    views.clear();
    void loading?.destroy();
    if (workerUrl) URL.revokeObjectURL(workerUrl);
    root.replaceChildren();
  }
  return { load, reset, destroy };
}
