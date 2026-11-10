import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { DefaultAssistantScreen } from "@/default-assistant/screen";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function AssistantRoute() {
  const serverId = useHostRouteServerId();
  const params = useLocalSearchParams<{ new?: string; provider?: string; model?: string }>();
  if (!serverId) return <StartupSplashScreen />;
  return (
    <HostRouteBootstrapBoundary>
      <DefaultAssistantScreen
        serverId={serverId}
        newSessionRequestId={params.new}
        provider={params.provider}
        model={params.model}
      />
    </HostRouteBootstrapBoundary>
  );
}
