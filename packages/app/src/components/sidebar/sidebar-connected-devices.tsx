import { useState } from "react";
import { Text, View } from "react-native";
import { MonitorSmartphone } from "lucide-react-native";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { SidebarFooterMenuTrigger } from "./sidebar-footer-menu-trigger";

function HostDevices({
  serverId,
  name,
  active,
}: {
  serverId: string;
  name: string;
  active: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["connected-devices", serverId],
    enabled: active && connected && Boolean(client),
    queryFn: async () => {
      if (!client) throw new Error("Host unavailable");
      const status = await client.getDaemonStatus({ timeout: 5000 });
      return { clients: status.connectedClients ?? null };
    },
    refetchInterval: active ? 5000 : false,
    staleTimeMs: 0,
    retry: false,
  });
  let message: string | null = null;
  if (!connected) message = t("connectedDevices.offline");
  else if (query.isError) message = t("connectedDevices.failed");
  else if (query.isPending) message = t("connectedDevices.loading");
  else if (query.data?.clients === null) message = t("connectedDevices.unsupported");
  else if (query.data?.clients.length === 0) message = t("connectedDevices.empty");
  return (
    <View style={styles.host}>
      <Text style={styles.hostName}>
        {name}
        {!message && query.data?.clients ? ` · ${query.data.clients.length}` : ""}
      </Text>
      {message ? (
        <Text style={styles.detail}>{message}</Text>
      ) : (
        query.data?.clients?.map((device) => (
          <View key={`${device.clientId}:${device.connectedAt}`} style={styles.device}>
            <Text numberOfLines={1} style={styles.name}>
              {device.label ?? device.clientType} · {device.clientId.slice(-6)}
              {device.isCurrentClient ? ` · ${t("connectedDevices.thisClient")}` : ""}
            </Text>
            <Text style={styles.detail}>
              {device.clientType}
              {device.appVersion ? ` · v${device.appVersion}` : ""}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}
export function SidebarConnectedDevicesContent({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  return (
    <View style={styles.content}>
      <Text style={styles.detail}>{t("connectedDevices.description")}</Text>
      {hosts.length === 0 ? (
        <Text style={styles.detail}>{t("connectedDevices.noHosts")}</Text>
      ) : null}
      {hosts.map((host) => (
        <HostDevices
          key={host.serverId}
          serverId={host.serverId}
          name={host.label || host.serverId}
          active={active}
        />
      ))}
    </View>
  );
}
export function SidebarConnectedDevicesMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <SidebarFooterMenuTrigger
        icon={MonitorSmartphone}
        label={t("connectedDevices.title")}
        menuOpen={open}
        testID="sidebar-devices-trigger"
      />
      <DropdownMenuContent side="top" align="start" offset={8} width={300} scrollable>
        <DropdownMenuLabel>{t("connectedDevices.title")}</DropdownMenuLabel>
        <SidebarConnectedDevicesContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  host: { gap: theme.spacing[1] },
  hostName: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
  device: { paddingVertical: theme.spacing[1] },
  name: { color: theme.colors.foreground, fontSize: 12 },
  detail: { color: theme.colors.foregroundMuted, fontSize: 11 },
}));
