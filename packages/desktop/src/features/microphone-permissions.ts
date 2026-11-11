import { updateActivity } from "../dev-update/activity.js";
import { app, BrowserWindow, dialog, ipcMain, shell, systemPreferences } from "electron";
import { createMicrophoneAccess } from "./microphone-access.js";

export function registerMicrophonePermissionHandlers(): void {
  const access = createMicrophoneAccess({
    platform: process.platform,
    getStatus: () => systemPreferences.getMediaAccessStatus("microphone"),
    askForAccess: () => systemPreferences.askForMediaAccess("microphone"),
    explainDenied: async () => {
      const korean = app.getLocale().startsWith("ko");
      const result = await dialog.showMessageBox({
        type: "warning",
        title: korean ? "마이크 권한이 필요해요" : "Microphone access required",
        message: korean
          ? "음성 기능을 사용하려면 macOS에서 이 앱의 마이크 접근을 허용해주세요."
          : "Allow microphone access for this app in macOS to use voice features.",
        detail: korean
          ? "개인정보 보호 및 보안 → 마이크에서 현재 실행 중인 Paseo 또는 Electron을 허용한 뒤 앱을 다시 열어주세요."
          : "In Privacy & Security → Microphone, allow the running Paseo or Electron app, then quit and reopen the app.",
        buttons: korean ? ["설정 열기", "취소"] : ["Open Settings", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0)
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        );
    },
  });
  function checkSender(event: Electron.IpcMainInvokeEvent): void {
    const mainFrame =
      event.senderFrame?.processId === event.sender.mainFrame.processId &&
      event.senderFrame?.routingId === event.sender.mainFrame.routingId;
    const ownedWindow = BrowserWindow.getAllWindows().some(
      (window) => window.webContents.id === event.sender.id,
    );
    if (!mainFrame || !ownedWindow)
      throw new Error("Microphone permission is available only to the app window");
  }
  ipcMain.handle("paseo:microphone:status", (event) => {
    checkSender(event);
    return access.getStatus();
  });
  ipcMain.handle("paseo:microphone:request", (event) => {
    checkSender(event);
    return updateActivity.run("native-dialog", () => access.requestAccess());
  });
}
