import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ConnectionsSettings } from "./client/connections-settings.js";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "connections",
    title: "외부 도구",
    icon: "Plug",
    Component: ConnectionsSettings,
  });
  client.addCommandCenterItem({
    id: "connections",
    title: "외부 도구 연결 관리",
    icon: "Plug",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("connections");
    },
  });
  return () => {};
}
