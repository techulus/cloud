type ServerWithResources = {
  id: string;
  resourcesCpu: number | null;
  resourcesMemory: number | null;
  resourcesDisk: number | null;
};

export function calculateServerScore(server: ServerWithResources): number {
  const cpuFree = 100 - (server.resourcesCpu ?? 100);
  const memoryFree = 100 - (server.resourcesMemory ?? 100);
  const diskFree = 100 - (server.resourcesDisk ?? 100);

  const score = (cpuFree * 0.3) + (memoryFree * 0.5) + (diskFree * 0.2);

  return score;
}

export function selectBestServer<T extends ServerWithResources>(servers: T[]): T | null {
  if (servers.length === 0) return null;

  return servers.reduce((best, current) => {
    return calculateServerScore(current) > calculateServerScore(best) ? current : best;
  });
}
