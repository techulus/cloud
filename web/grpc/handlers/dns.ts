import { db } from "@/db";
import { deployments, services } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { connectionStore } from "../store/connections";
import type { DnsRecord } from "../generated/proto/agent";

export async function getAllDnsRecords(): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];

  const allServices = await db.select().from(services);

  for (const service of allServices) {
    const runningDeployments = await db
      .select({ ipAddress: deployments.ipAddress })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, service.id),
          eq(deployments.status, "running")
        )
      );

    const ips = runningDeployments
      .map((d) => d.ipAddress)
      .filter((ip): ip is string => ip !== null);

    if (ips.length > 0) {
      records.push({
        name: `${service.name}.internal`,
        ips,
      });
    }
  }

  return records;
}

export async function pushDnsConfigToAll(): Promise<void> {
  const records = await getAllDnsRecords();
  connectionStore.pushDnsConfig(records);
}
