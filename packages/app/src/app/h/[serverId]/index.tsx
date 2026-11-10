import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { DefaultAssistantScreen } from "@/default-assistant/screen";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostIndexRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) return <StartupSplashScreen />;
  return (
    <HostRouteBootstrapBoundary>
      <DefaultAssistantScreen serverId={serverId} />
    </HostRouteBootstrapBoundary>
  );
}
