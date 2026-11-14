import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AppVersionStatus,
  ConnectedAppVersionStatus,
  DevelopmentBuildBadge,
  type LocalAppUpdate,
} from "./app-version-status";
import { i18n } from "@/i18n/i18next";

import type { DesktopLocalUpdateBridge, DesktopLocalUpdateStatus } from "@/desktop/host";
const readyStatus: DesktopLocalUpdateStatus = {
  currentVersion: "1",
  phase: "idle",
  canApply: true,
  candidate: { version: "2", token: "a".repeat(64) },
};
function setBridge(localUpdate: DesktopLocalUpdateBridge) {
  Object.defineProperty(window, "paseoDesktop", { configurable: true, value: { localUpdate } });
}
let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  delete window.paseoDesktop;
});
function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}
function mountUpdate(update: LocalAppUpdate) {
  return mount(<AppVersionStatus version="1" update={update} productionReady />);
}
it("shows the current version without an update action by default", () => {
  const view = mount(<AppVersionStatus version="0.15.4" />);
  expect(view.textContent).toBe("v0.15.4");
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});
it("does not offer an update for an empty or unavailable candidate", () => {
  const update: LocalAppUpdate = {
    status: "verified",
    releaseId: " ",
    onUpdateAndRestart: vi.fn(),
  };
  const view = mountUpdate(update);
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});
it("invokes only the supplied verified update action", () => {
  const onUpdateAndRestart = vi.fn();
  const update: LocalAppUpdate = { status: "verified", releaseId: "local-2", onUpdateAndRestart };
  const view = mountUpdate(update);
  const button = view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!;
  expect(button.textContent).toBe("Update and restart");
  act(() => button.click());
  expect(onUpdateAndRestart).toHaveBeenCalledTimes(1);
});
it("disables repeat requests while pending", () => {
  const onUpdateAndRestart = vi.fn();
  const update: LocalAppUpdate = {
    status: "verified",
    releaseId: "local-2",
    pending: true,
    onUpdateAndRestart,
  };
  const view = mountUpdate(update);
  act(() => view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!.click());
  expect(onUpdateAndRestart).not.toHaveBeenCalled();
});
it("keeps the build label separate from the version", () => {
  const view = mount(<DevelopmentBuildBadge label="supervised-runtime" />);
  expect(view.textContent).toBe("supervised-runtime");
  expect(view.querySelector('[aria-label="Development build: supervised-runtime"]')).not.toBeNull();
});
it("does not invent a build label for installed releases", () => {
  const view = mount(<DevelopmentBuildBadge label={null} />);
  expect(view.textContent).toBe("");
});

it("hides even a verified update until production readiness is explicitly enabled", () => {
  const update: LocalAppUpdate = {
    status: "verified",
    releaseId: "local-2",
    onUpdateAndRestart: vi.fn(),
  };
  function renderDisabled(candidate: LocalAppUpdate) {
    return mount(<AppVersionStatus version="1" update={candidate} />);
  }
  const view = renderDisabled(update);
  expect(view.textContent).toBe("v1");
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});

it("connected version hides action without desktop bridge", async () => {
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});
it("connected version requests only eligible opaque token and blocks duplicate clicks", async () => {
  let finish: (() => void) | undefined;
  const request = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  setBridge({ status: vi.fn(async () => readyStatus), request });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  const button = view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!;
  expect(button).not.toBeNull();
  act(() => {
    button.click();
    button.click();
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(readyStatus.candidate!.token);
  await act(async () => {
    finish?.();
  });
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});
it("connected version hides failed/unavailable and malformed offers", async () => {
  for (const status of [
    { ...readyStatus, canApply: false },
    { ...readyStatus, phase: "failed" as const },
    { ...readyStatus, candidate: { version: "2", token: "not-a-token" } },
  ]) {
    setBridge({ status: vi.fn(async () => status), request: vi.fn() });
    const view = mount(<ConnectedAppVersionStatus />);
    await act(async () => {});
    expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
    act(() => root?.unmount());
    root = undefined;
    container.remove();
  }
});
it("connected version hides action after request failure without exposing native error", async () => {
  setBridge({
    status: vi.fn(async () => readyStatus),
    request: vi.fn(async () => {
      throw Error("private-path");
    }),
  });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  await act(async () => {
    view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!.click();
  });
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
  expect(view.textContent).not.toContain("private-path");
});
it("connected version ignores late status after unmount and unregisters listeners", async () => {
  let finish: ((status: DesktopLocalUpdateStatus) => void) | undefined;
  const status = vi.fn(
    () =>
      new Promise<DesktopLocalUpdateStatus>((resolve) => {
        finish = resolve;
      }),
  );
  setBridge({ status, request: vi.fn() });
  mount(<ConnectedAppVersionStatus />);
  act(() => root?.unmount());
  root = undefined;
  await act(async () => {
    finish?.(readyStatus);
  });
  window.dispatchEvent(new Event("focus"));
  expect(status).toHaveBeenCalledTimes(1);
});
it("connected version quietly handles missing IPC registration", async () => {
  setBridge({
    status: vi.fn(async () => {
      throw Error("No handler registered");
    }),
    request: vi.fn(),
  });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});

it("offers a verified update even when version strings are equal", async () => {
  const request = vi.fn(async () => {});
  setBridge({
    status: vi.fn(async () => ({
      ...readyStatus,
      candidate: { ...readyStatus.candidate!, version: readyStatus.currentVersion },
    })),
    request,
  });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).not.toBeNull();
});

it("shows a blocked response and restores a button only for a verified retryable offer", async () => {
  let rejected = false;
  const request = vi.fn(async () => {
    rejected = true;
    throw Error("/secret/private-path");
  });
  setBridge({
    status: vi.fn(async () => ({
      ...readyStatus,
      ...(rejected ? { failure: { code: "blocked" as const, retryable: true } } : {}),
    })),
    request,
  });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  await act(async () => {
    view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!.click();
  });
  expect(view.querySelector('[data-testid="local-app-update-error"]')?.textContent).toContain(
    "blocked",
  );
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).not.toBeNull();
  expect(view.textContent).not.toContain("private-path");
  await act(async () => {
    view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!.click();
  });
  expect(request).toHaveBeenCalledTimes(2);
});
it("announces unknown failure without restoring the consumed button", async () => {
  setBridge({
    status: vi.fn(async () => readyStatus),
    request: vi.fn(async () => {
      throw Error("private-path");
    }),
  });
  const view = mount(<ConnectedAppVersionStatus />);
  await act(async () => {});
  await act(async () => {
    view.querySelector<HTMLElement>('[data-testid="local-app-update-restart"]')!.click();
  });
  expect(view.querySelector('[data-testid="local-app-update-error"]')?.textContent).toContain(
    "failed",
  );
  expect(view.querySelector('[data-testid="local-app-update-restart"]')).toBeNull();
});
