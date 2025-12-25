import { db } from "@/db";
import { serverContainers } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

type ServerWithResources = {
  id: string;
  resourcesCpu: number | null;
  resourcesMemory: number | null;
  resourcesDisk: number | null;
};

export function calculateCapacityScore(server: ServerWithResources): number {
  const cpuCores = server.resourcesCpu ?? 1;
  const memoryMB = server.resourcesMemory ?? 1024;
  const diskGB = server.resourcesDisk ?? 10;

  return cpuCores + (memoryMB / 1024) + (diskGB / 100);
}

export async function selectBestServer<T extends ServerWithResources>(servers: T[]): Promise<T | null> {
  if (servers.length === 0) return null;

  const containerCounts = await db
    .select({
      serverId: serverContainers.serverId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(serverContainers)
    .groupBy(serverContainers.serverId);

  const countMap = new Map(containerCounts.map((c) => [c.serverId, c.count]));

  let bestServer: T | null = null;
  let bestScore = -1;

  for (const server of servers) {
    const containerCount = countMap.get(server.id) ?? 0;
    const capacityScore = calculateCapacityScore(server);
    const finalScore = capacityScore / (containerCount + 1);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestServer = server;
    }
  }

  return bestServer;
}
