import type * as grpc from "@grpc/grpc-js";
import type { ControlPlaneMessage, CaddyRoute } from "../generated/proto/agent";

interface Connection {
  serverId: string;
  serverName: string;
  stream: grpc.ServerDuplexStream<unknown, ControlPlaneMessage>;
  connectedAt: Date;
  lastHeartbeat: Date;
  sessionId: string;
  isProxy: boolean;
}

class ConnectionStore {
  private connections: Map<string, Connection> = new Map();

  add(
    serverId: string,
    serverName: string,
    stream: grpc.ServerDuplexStream<unknown, ControlPlaneMessage>,
    sessionId: string,
    isProxy: boolean
  ): void {
    const existing = this.connections.get(serverId);
    if (existing) {
      try {
        existing.stream.end();
      } catch {
      }
    }

    this.connections.set(serverId, {
      serverId,
      serverName,
      stream,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      sessionId,
      isProxy,
    });
  }

  remove(serverId: string): void {
    this.connections.delete(serverId);
  }

  get(serverId: string): Connection | undefined {
    return this.connections.get(serverId);
  }

  updateHeartbeat(serverId: string): void {
    const conn = this.connections.get(serverId);
    if (conn) {
      conn.lastHeartbeat = new Date();
    }
  }

  getAll(): Connection[] {
    return Array.from(this.connections.values());
  }

  getProxyConnections(): Connection[] {
    return Array.from(this.connections.values()).filter((c) => c.isProxy);
  }

  size(): number {
    return this.connections.size;
  }

  pushCaddyConfig(routes: CaddyRoute[]): void {
    const proxyConnections = this.getProxyConnections();
    for (const conn of proxyConnections) {
      try {
        conn.stream.write({
          caddy_config: { routes },
        });
        console.log(`[grpc:send] server=${conn.serverId} type=CaddyConfig routes=${routes.length}`);
      } catch (error) {
        console.error(`Failed to push CaddyConfig to ${conn.serverName}:`, error);
      }
    }
  }
}

export const connectionStore = new ConnectionStore();
