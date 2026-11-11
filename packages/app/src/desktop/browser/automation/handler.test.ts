import { beforeEach, describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { mountBrowserAutomationHandler } from "./handler";
import { useWorkspaceBrowserStore } from "../workspace-store";
import type { DesktopHostBridge } from "@/desktop/host";
import { useBrowserStore } from "@/desktop/browser/store";
import { findPaneById } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];

class FakeStateStorage implements StateStorage {
  private readonly values = new Map<string, string>();

  public getItem = (key: string): string | null => this.values.get(key) ?? null;

  public setItem = (key: string, value: string): void => {
    this.values.set(key, value);
  };

  public removeItem = (key: string): void => {
    this.values.delete(key);
  };

  public clear(): void {
    this.values.clear();
  }
}

class FakeDaemonClient {
  public readonly sentResponses: BrowserAutomationExecuteResponse[] = [];
  private handler: ((request: BrowserAutomationExecuteRequest) => void) | null = null;

  public on(
    type: "browser.automation.execute.request",
    handler: (request: BrowserAutomationExecuteRequest) => void,
  ): () => void {
    expect(type).toBe("browser.automation.execute.request");
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  public sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void {
    this.sentResponses.push(response);
  }

  public receive(nextRequest: BrowserAutomationExecuteRequest): void {
    this.handler?.(nextRequest);
  }

  public payloadAt(index: number): BrowserAutomationResponsePayload {
    const response = this.sentResponses[index];
    if (!response) {
      throw new Error(`Missing browser automation response at index ${index}`);
    }
    return response.payload;
  }
}

class FakeBrowserBridge {
  public readonly executedRequests: BrowserAutomationExecuteRequest[] = [];
  public readonly unregisteredWorkspaceBrowsers: string[] = [];
  public readonly activeWorkspaceBrowsers: Array<{
    browserId: string | null;
    workspaceId: string;
  }> = [];
  public response: BrowserAutomationResponsePayload | null = null;
  public thrownError: unknown = null;

  public executeAutomationCommand = async (
    request: BrowserAutomationExecuteRequest,
  ): Promise<BrowserAutomationResponsePayload> => {
    this.executedRequests.push(request);
    if (this.thrownError) {
      throw this.thrownError;
    }
    return this.response ?? currentListTabsPayload(request.requestId);
  };

  public unregisterWorkspaceBrowser = async (browserId: string): Promise<void> => {
    this.unregisteredWorkspaceBrowsers.push(browserId);
  };

  public setWorkspaceActiveBrowser = async (input: {
    browserId: string | null;
    workspaceId: string;
  }): Promise<void> => {
    this.activeWorkspaceBrowsers.push(input);
  };
}

class FakeResidentBrowser {
  public readonly ensuredWebviews: Array<{
    browserId: string;
    workspaceId: string;
    url: string;
  }> = [];

  public ensure = (input: {
    browserId: string;
    workspaceId: string;
    url: string;
  }): HTMLElement | null => {
    this.ensuredWebviews.push(input);
    return null;
  };
}

class BrowserAutomationHandlerHarness {
  public readonly client = new FakeDaemonClient();
  public readonly browser = new FakeBrowserBridge();
  public readonly resident = new FakeResidentBrowser();
  private unsubscribe: (() => void) | null = null;

  public mount(
    input: {
      serverId?: string;
      host?: DesktopHostBridge | null;
      registrationWaitTimeoutMs?: number;
      registrationPollIntervalMs?: number;
    } = {},
  ): void {
    this.unsubscribe = mountBrowserAutomationHandler({
      client: this.client,
      ...(input.serverId ? { serverId: input.serverId } : {}),
      getHost: () => (input.host === undefined ? { browser: this.browser } : input.host),
      ensureResidentBrowserWebview: this.resident.ensure,
      ...(input.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: input.registrationWaitTimeoutMs }
        : {}),
      ...(input.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: input.registrationPollIntervalMs }
        : {}),
    });
  }

  public unmount(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  public receive(request: BrowserAutomationExecuteRequest): void {
    this.client.receive(request);
  }
}

function browserAutomationRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-1",
    command: { command: "list_tabs", args: {} },
  };
}

function browserNewTabRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-new",
    agentId: "agent-1",
    workspaceId: "wks_workspace_a",
    command: {
      command: "new_tab",
      args: { url: "https://example.com" },
    },
  };
}

function browserResizeRequest(
  browserId: string,
  input: { workspaceId?: string } = {},
): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-resize",
    agentId: "agent-1",
    workspaceId: input.workspaceId ?? "wks_workspace_a",
    command: {
      command: "resize",
      args: { browserId, width: 1024, height: 768 },
    },
  };
}

function browserCloseTabRequest(browserId: string): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-close-tab",
    agentId: "agent-1",
    workspaceId: "wks_workspace_a",
    command: {
      command: "close_tab",
      args: { browserId },
    },
  };
}

function emptyListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: [],
    },
  };
}

function currentListTabsPayload(requestId = "req-new:list_tabs"): BrowserAutomationResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "list_tabs",
      tabs: currentBrowserTabs(),
    },
  };
}

function currentBrowserTabs() {
  return Object.values(useBrowserStore.getState().browsersById).map((browser) => ({
    browserId: browser.browserId,
    workspaceId: "wks_workspace_a",
    url: browser.url,
    title: browser.title,
    isActive: true,
    isLoading: false,
  }));
}

function newTabResultFrom(payload: BrowserAutomationResponsePayload) {
  expect(payload).toMatchObject({
    requestId: "req-new",
    ok: true,
    result: { command: "new_tab", workspaceId: "wks_workspace_a", url: "https://example.com" },
  });
  if (!payload.ok || payload.result.command !== "new_tab") {
    throw new Error("Expected browser_new_tab success payload");
  }
  return payload.result;
}

function workspaceBrowserTabs(workspaceKey: string, browserId: string) {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .filter((tab) => tab.target.kind === "browser" && tab.target.browserId === browserId);
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitForRegistrationTimeout(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const browserAutomationStorage = new FakeStateStorage();
useBrowserStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});
useWorkspaceLayoutStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});

useWorkspaceBrowserStore.persist.setOptions({
  storage: createJSONStorage(() => browserAutomationStorage),
});

describe("mountBrowserAutomationHandler", () => {
  beforeEach(() => {
    browserAutomationStorage.clear();
    useBrowserStore.setState({ browsersById: {} });
    useWorkspaceBrowserStore.setState({ panelsByWorkspace: {} });
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      sidePaneIdByWorkspace: {},
      layoutMode: "split-panes",
      focusRequest: null,
    });
  });

  test("browser_new_tab opens a page inside the existing sidebar without adding a main workspace tab", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    const previousFocusedTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: workspaceKey,
      target: { kind: "draft", draftId: "human-draft" },
      intent: "reveal",
    });
    const previousFocusRequest = useWorkspaceLayoutStore.getState().focusRequest;
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    const result = newTabResultFrom(browser.client.payloadAt(0));
    const openedTabs = workspaceBrowserTabs(workspaceKey, result.browserId);
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    expect(openedTabs).toEqual([]);
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]).toEqual({
      browserIds: [result.browserId],
      activeBrowserId: result.browserId,
    });
    if (!layout) {
      throw new Error("Expected workspace layout");
    }
    expect(layout.root.kind).toBe("group");
    const sidebar = findPaneById(layout.root, "explorer");
    expect(sidebar?.hidden).not.toBe(true);
    expect(sidebar?.focusedTabId).toBe("browser_workspace");
    expect(sidebar?.tabIds.filter((id) => id === "browser_workspace")).toHaveLength(1);

    expect(findPaneById(layout.root, "main")).toEqual(
      expect.objectContaining({ focusedTabId: previousFocusedTabId }),
    );
    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[workspaceKey]).toBeUndefined();
    expect(layout.focusedPaneId).toBe("main");
    expect(useWorkspaceLayoutStore.getState().focusRequest).toEqual(previousFocusRequest);
    expect(browser.browser.activeWorkspaceBrowsers).toEqual([]);
    expect(browser.resident.ensuredWebviews).toEqual([
      {
        browserId: result.browserId,
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      },
    ]);
    expect(browser.browser.executedRequests).toEqual([
      {
        type: "browser.automation.execute.request",
        requestId: "req-new:list_tabs",
        agentId: "agent-1",
        workspaceId: "wks_workspace_a",
        command: { command: "list_tabs", args: {} },
      },
    ]);
  });

  test("hidden sidebar keeps processing commands and new pages without reopening", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) throw new Error("Expected workspace key");
    useWorkspaceLayoutStore
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId: "agent-1" }, intent: "reveal" });
    browser.mount({ serverId: "server-1" });
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const first = newTabResultFrom(browser.client.payloadAt(0));
    useWorkspaceLayoutStore.getState().hideExplorerSidebar(workspaceKey);
    browser.receive({
      ...browserNewTabRequest(),
      requestId: "hidden-snapshot",
      command: { command: "snapshot", args: { browserId: first.browserId } },
    });
    await flushAsyncWork();
    expect(
      findPaneById(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
        "explorer",
      )?.hidden,
    ).toBe(true);
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    expect(
      findPaneById(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
        "explorer",
      )?.hidden,
    ).toBe(true);
    expect(
      useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]?.browserIds,
    ).toHaveLength(2);
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([]);
    useWorkspaceLayoutStore.getState().showExplorerSidebar(workspaceKey);
    expect(
      findPaneById(
        useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root,
        "explorer",
      )?.hidden,
    ).not.toBe(true);
  });

  test("commands follow the existing browser in the same right pane while preserving the conversation", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) throw new Error("Expected workspace key");
    const store = useWorkspaceLayoutStore.getState();
    const chatTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    const focusRequest = useWorkspaceLayoutStore.getState().focusRequest;
    browser.mount({ serverId: "server-1" });
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const first = newTabResultFrom(browser.client.payloadAt(0));
    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const second = newTabResultFrom(browser.client.payloadAt(1));
    expect(
      useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]?.activeBrowserId,
    ).toBe(second.browserId);

    browser.receive({
      ...browserNewTabRequest(),
      requestId: "req-snapshot-first",
      command: { command: "snapshot", args: { browserId: first.browserId } },
    });
    await flushAsyncWork();
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(state.sidePaneIdByWorkspace[workspaceKey]).toBeUndefined();
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]).toEqual({
      browserIds: [first.browserId, second.browserId],
      activeBrowserId: first.browserId,
    });
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(chatTabId);
    expect(layout.focusedPaneId).toBe("main");
    expect(state.focusRequest).toEqual(focusRequest);
    expect(browser.resident.ensuredWebviews).toHaveLength(2);
    const sidebar = findPaneById(layout.root, "explorer");
    expect(sidebar?.tabIds.filter((id) => id === "browser_workspace")).toHaveLength(1);
    expect(sidebar?.focusedTabId).toBe("browser_workspace");

    browser.receive(browserCloseTabRequest(first.browserId));
    await flushAsyncWork();
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]).toEqual({
      browserIds: [second.browserId],
      activeBrowserId: second.browserId,
    });
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([first.browserId]);
    expect(useBrowserStore.getState().browsersById[second.browserId]).toBeDefined();
  });

  test("commands present a previously background browser from the main pane without recreating it", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) throw new Error("Expected workspace key");
    const browserId = useBrowserStore
      .getState()
      .createBrowser({ initialUrl: "https://example.com" });
    const store = useWorkspaceLayoutStore.getState();
    const chatTabId = store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "browser", browserId },
      intent: "background",
    });
    browser.mount({ serverId: "server-1" });
    browser.receive({
      ...browserNewTabRequest(),
      command: { command: "snapshot", args: { browserId } },
    });
    await flushAsyncWork();
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[workspaceKey];
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]).toEqual({
      browserIds: [browserId],
      activeBrowserId: browserId,
    });
    expect(findPaneById(layout.root, "main")?.tabIds).toEqual([chatTabId]);
    expect(layout.focusedPaneId).toBe("main");
    expect(workspaceBrowserTabs(workspaceKey, browserId)).toEqual([]);
    expect(browser.resident.ensuredWebviews).toEqual([]);
  });

  test.each(["compact", "single-pane"] as const)(
    "%s layouts keep browser automation in the background",
    async (layoutMode) => {
      useWorkspaceLayoutStore.setState({ layoutMode });
      const browser = new BrowserAutomationHandlerHarness();
      const workspaceKey = buildWorkspaceTabPersistenceKey({
        serverId: "server-1",
        workspaceId: "wks_workspace_a",
      });
      if (!workspaceKey) throw new Error("Expected workspace key");
      const chatTabId = useWorkspaceLayoutStore
        .getState()
        .openTab({ workspaceKey, target: { kind: "agent", agentId: "agent-1" }, intent: "reveal" });
      browser.mount({ serverId: "server-1" });
      browser.receive(browserNewTabRequest());
      await flushAsyncWork();
      newTabResultFrom(browser.client.payloadAt(0));
      const state = useWorkspaceLayoutStore.getState();
      expect(state.sidePaneIdByWorkspace[workspaceKey]).toBeUndefined();
      expect(findPaneById(state.layoutByWorkspace[workspaceKey].root, "main")?.focusedTabId).toBe(
        chatTabId,
      );
    },
  );

  test("browser_new_tab returns a retryable timeout when the resident webview does not register", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = emptyListTabsPayload();
    browser.mount({
      serverId: "server-1",
      registrationWaitTimeoutMs: 1,
      registrationPollIntervalMs: 1,
    });

    browser.receive(browserNewTabRequest());
    await waitForRegistrationTimeout();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_timeout",
            message: expect.stringContaining("Timed out waiting for browser tab"),
            retryable: true,
          },
        },
      },
    ]);
    expect(browser.resident.ensuredWebviews).toEqual([
      expect.objectContaining({
        workspaceId: "wks_workspace_a",
        url: "https://example.com",
      }),
    ]);
  });

  test("browser_new_tab wraps registration bridge errors in a response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error("IPC registration check failed");
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-new",
          ok: false,
          error: {
            code: "browser_unknown_error",
            message: "IPC registration check failed",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("browser_resize updates resident webview dimensions", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-resize",
      ok: true,
      result: {
        command: "resize",
        browserId: result.browserId,
        width: 1024,
        height: 768,
      },
    });
    expect(useBrowserStore.getState().browsersById[result.browserId]?.viewport).toEqual({
      mode: "fixed",
      width: 1024,
      height: 768,
    });
    expect(browser.browser.executedRequests).toHaveLength(1);
  });

  test("browser_resize returns not found for a tab outside the request workspace", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserResizeRequest(result.browserId, { workspaceId: "wks_workspace_b" }));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-resize",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
  });

  test("browser_close_tab removes the workspace tab, browser record, resident webview, and registry entry", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: "server-1",
      workspaceId: "wks_workspace_a",
    });
    if (!workspaceKey) {
      throw new Error("Expected workspace key");
    }
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(1)).toEqual({
      requestId: "req-close-tab",
      ok: true,
      result: { command: "close_tab", browserId: result.browserId },
    });
    expect(workspaceBrowserTabs(workspaceKey, result.browserId)).toEqual([]);
    expect(useWorkspaceBrowserStore.getState().panelsByWorkspace[workspaceKey]?.browserIds).toEqual(
      [],
    );
    expect(useBrowserStore.getState().browsersById[result.browserId]).toBeUndefined();
    expect(browser.browser.unregisteredWorkspaceBrowsers).toEqual([result.browserId]);
    expect(currentBrowserTabs()).toEqual([]);
  });

  test("browser_close_tab returns not found after the tab is gone", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ serverId: "server-1" });

    browser.receive(browserNewTabRequest());
    await flushAsyncWork();
    const result = newTabResultFrom(browser.client.payloadAt(0));

    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();
    browser.receive(browserCloseTabRequest(result.browserId));
    await flushAsyncWork();

    expect(browser.client.payloadAt(2)).toEqual({
      requestId: "req-close-tab",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: `No browser tab found for ID: ${result.browserId}`,
        retryable: false,
      },
    });
  });

  test("non-new-tab requests send the desktop bridge response", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.response = {
      requestId: "desktop-req",
      ok: true,
      result: { command: "list_tabs", tabs: [] },
    };
    browser.mount();
    const request = browserAutomationRequest();

    browser.receive(request);
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([request]);
    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      },
    ]);
  });

  test("missing desktop bridge sends browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount({ host: null });

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Browser automation is not available in this app runtime.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("typed bridge errors become failure responses", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = {
      code: "browser_tab_not_found",
      message: "Browser tab browser-1 was not found.",
      retryable: false,
    };
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_tab_not_found",
            message: "Browser tab browser-1 was not found.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unimplemented preload IPC reports browser_unsupported", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.browser.thrownError = new Error(
      'No handler registered for "paseo:browser:execute-automation-command"',
    );
    browser.mount();

    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Browser automation is not implemented by this app build yet.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("unsubscribe stops handling browser automation requests", async () => {
    const browser = new BrowserAutomationHandlerHarness();
    browser.mount();

    browser.unmount();
    browser.receive(browserAutomationRequest());
    await flushAsyncWork();

    expect(browser.browser.executedRequests).toEqual([]);
    expect(browser.client.sentResponses).toEqual([]);
  });
});
