import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { LocalSessionsScreen } from "@/local-sessions/screen";
export default function LocalSessionsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <LocalSessionsScreen />
    </HostRouteBootstrapBoundary>
  );
}
