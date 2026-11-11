import { contextBridge, ipcRenderer } from "electron";
import type { BrowserKeyboardPolicy, BrowserShortcutPrefix } from "./policy.js";

const POLICY_CHANNEL = "paseo:browser-keyboard-policy";
const POLICY_REQUEST_CHANNEL = "paseo:browser-keyboard-policy-request";
const SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";

let browserId: string | null = null;
let policy: BrowserShortcutPrefix[] = [];

interface BrowserKeyboardPolicyPayload extends BrowserKeyboardPolicy {
  browserId: string;
}

function matchesPolicy(event: KeyboardEvent): boolean {
  const editable = isEditableTarget(event.target);
  return policy.some((prefix) => {
    if (
      prefix.alt !== event.altKey ||
      prefix.control !== event.ctrlKey ||
      prefix.meta !== event.metaKey ||
      prefix.shift !== event.shiftKey ||
      (prefix.editable === false && editable) ||
      (prefix.repeat === false && event.repeat)
    ) {
      return false;
    }
    if (prefix.key === undefined) {
      return matchesCode(prefix.code, event.code);
    }
    const eventKey = event.key.toLowerCase();
    if (eventKey === prefix.key) {
      return true;
    }
    if (prefix.shift && prefix.shiftedKey !== undefined && eventKey === prefix.shiftedKey) {
      return true;
    }
    return (prefix.alt || prefix.codeFallback === true) && matchesCode(prefix.code, event.code);
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const element = target as HTMLElement;
  if (element.isContentEditable) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function matchesCode(prefixCode: string, eventCode: string): boolean {
  if (prefixCode !== "Digit") {
    return prefixCode === eventCode;
  }
  return /^(?:Digit|Numpad)[1-9]$/.test(eventCode);
}

function stageShortcutForward(event: KeyboardEvent): void {
  if (!event.isTrusted || event.defaultPrevented || !browserId || !matchesPolicy(event)) {
    return;
  }

  const shortcutBrowserId = browserId;
  window.addEventListener(
    "keydown",
    (completedEvent) => {
      if (completedEvent !== event || completedEvent.defaultPrevented) {
        return;
      }
      completedEvent.preventDefault();
      ipcRenderer.send(SHORTCUT_INPUT_CHANNEL, {
        alt: completedEvent.altKey,
        browserId: shortcutBrowserId,
        code: completedEvent.code,
        control: completedEvent.ctrlKey,
        key: completedEvent.key,
        meta: completedEvent.metaKey,
        repeat: completedEvent.repeat,
        shift: completedEvent.shiftKey,
      });
    },
    { once: true },
  );
}

window.addEventListener("keydown", stageShortcutForward, { capture: true });

ipcRenderer.on(POLICY_CHANNEL, (_event, value: BrowserKeyboardPolicyPayload) => {
  if (!value || typeof value.browserId !== "string" || !Array.isArray(value.prefixes)) {
    return;
  }
  browserId = value.browserId;
  policy = value.prefixes;
});

ipcRenderer.send(POLICY_REQUEST_CHANNEL);

// Runs in every frame via the existing sandboxed guest preload. No page data is sent.
const reportUpdateState = (kind: "ready" | "opaque") =>
  ipcRenderer.send("paseo:dev-update:guest", kind);
for (const eventName of [
  "input",
  "change",
  "keydown",
  "pointerdown",
  "drop",
  "paste",
  "submit",
  "play",
] as const) {
  window.addEventListener(eventName, () => reportUpdateState("opaque"), true);
}
window.addEventListener(
  "DOMContentLoaded",
  () => {
    // Unknown forms, canvas, media and embedded surfaces cannot promise heap restoration.
    if (
      document.querySelector(
        "form,input,textarea,select,[contenteditable],canvas,video,audio,object,embed",
      )
    )
      reportUpdateState("opaque");
    reportUpdateState("ready");
  },
  { once: true },
);

// Stale/blocked frame event loops (including modal dialogs) cannot acknowledge a checkpoint.
setInterval(() => reportUpdateState("ready"), 1000);
const updateSurfaceObserver = new MutationObserver(() => {
  if (
    document.querySelector(
      "form,input,textarea,select,[contenteditable],canvas,video,audio,object,embed",
    )
  )
    reportUpdateState("opaque");
});
updateSurfaceObserver.observe(document, { childList: true, subtree: true, attributes: true });

// Capture/dialog use creates non-restorable state even when no visible form exists.
// The page can only mark itself opaque through this event, never clear the native guard.
window.addEventListener("paseo-update-opaque", () => reportUpdateState("opaque"));
try {
  contextBridge.executeInMainWorld({
    func: () => {
      const mark = () => window.dispatchEvent(new Event("paseo-update-opaque"));
      for (const name of ["alert", "confirm", "prompt"] as const) {
        const original = window[name];
        Object.defineProperty(window, name, {
          configurable: true,
          writable: true,
          value: function (...args: unknown[]) {
            mark();
            return Reflect.apply(original, window, args);
          },
        });
      }
      const media = navigator.mediaDevices;
      if (media)
        for (const name of ["getUserMedia", "getDisplayMedia"] as const) {
          const original = media[name];
          if (typeof original !== "function") continue;
          Object.defineProperty(media, name, {
            configurable: true,
            writable: true,
            value: function (...args: unknown[]) {
              mark();
              return Reflect.apply(original, media, args);
            },
          });
        }
    },
  });
} catch {
  // Failed instrumentation is unknown, not proof that a guest is safe.
  reportUpdateState("opaque");
}
