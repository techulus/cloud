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
  lastAgentSequence: number;
  outgoingSequence: number;
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
      } catch {}
    }

    this.connections.set(serverId, {
      serverId,
      serverName,
      stream,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      sessionId,
      isProxy,
      lastAgentSequence: 0,
      outgoingSequence: 0,
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

  validateAndUpdateSequence(serverId: string, sequence: number): boolean {
    const conn = this.connections.get(serverId);
    if (!conn) return false;

    if (sequence <= conn.lastAgentSequence) {
      console.error(
        `[grpc:replay] server=${serverId} expected>${conn.lastAgentSequence} got=${sequence}`
      );
      return false;
    }

    conn.lastAgentSequence = sequence;
    return true;
  }

  getNextOutgoingSequence(serverId: string): number {
    const conn = this.connections.get(serverId);
    if (!conn) return 1;
    conn.outgoingSequence += 1;
    return conn.outgoingSequence;
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

  sendMessage(
    serverId: string,
    payload: Omit<ControlPlaneMessage, "sequence">
  ): boolean {
    const conn = this.connections.get(serverId);
    if (!conn) return false;

    try {
      const sequence = this.getNextOutgoingSequence(serverId);
      conn.stream.write({ ...payload, sequence });
      return true;
    } catch (error) {
      console.error(`Failed to send message to ${conn.serverName}:`, error);
      return false;
    }
  }

  pushCaddyConfig(routes: CaddyRoute[]): void {
    const proxyConnections = this.getProxyConnections();
    for (const conn of proxyConnections) {
      const success = this.sendMessage(conn.serverId, {
        caddy_config: { routes },
      });
      if (success) {
        console.log(
          `[grpc:send] server=${conn.serverId} type=CaddyConfig routes=${routes.length}`
        );
      }
    }
  }
}

export const connectionStore = new ConnectionStore();
