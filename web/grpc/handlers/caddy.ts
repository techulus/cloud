import { getAllRoutes } from "@/lib/caddy";
import { connectionStore } from "../store/connections";
import type { CaddyRoute } from "../generated/proto/agent";

export async function pushCaddyConfigToAll(): Promise<void> {
  const routes = await getAllRoutes();

  const caddyRoutes: CaddyRoute[] = routes.map((route) => ({
    id: route.id,
    domain: route.domain,
    upstreams: route.upstreams,
    internal: route.internal,
  }));

  connectionStore.pushCaddyConfig(caddyRoutes);
}
