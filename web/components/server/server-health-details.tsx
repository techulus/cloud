"use client";

import {
	Activity,
	Container,
	Cpu,
	HardDrive,
	MemoryStick,
	Network,
} from "lucide-react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResourceBar } from "@/components/cluster/resource-bar";
import { HealthIndicator } from "@/components/cluster/health-indicator";
import { Separator } from "@/components/ui/separator";
import { fetcher } from "@/lib/fetcher";
import type { Server } from "@/db/types";

type ServerHealthData = {
	healthStats: Server["healthStats"];
	networkHealth: Server["networkHealth"];
	containerHealth: Server["containerHealth"];
	agentHealth: Server["agentHealth"];
};

type ClusterHealthResponse = {
	servers: Array<
		ServerHealthData & {
			id: string;
			name: string;
			status: string;
		}
	>;
};

interface ServerHealthDetailsProps {
	serverId: string;
	initialData: ServerHealthData;
}

export function ServerHealthDetails({
	serverId,
	initialData,
}: ServerHealthDetailsProps) {
	const { data } = useSWR<ClusterHealthResponse>(
		"/api/cluster-health",
		fetcher,
		{
			refreshInterval: 10000,
		},
	);

	const serverData = data?.servers?.find((s) => s.id === serverId);
	const healthStats = serverData?.healthStats ?? initialData.healthStats;
	const networkHealth = serverData?.networkHealth ?? initialData.networkHealth;
	const containerHealth =
		serverData?.containerHealth ?? initialData.containerHealth;
	const agentHealth = serverData?.agentHealth ?? initialData.agentHealth;

	if (!healthStats && !networkHealth && !containerHealth && !agentHealth) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>System Health</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{healthStats && (
					<div className="grid gap-4 sm:grid-cols-3">
						<ResourceBar
							value={healthStats.cpuUsagePercent}
							label="CPU"
							icon={<Cpu className="size-4" />}
						/>
						<ResourceBar
							value={healthStats.memoryUsagePercent}
							label="Memory"
							icon={<MemoryStick className="size-4" />}
						/>
						<ResourceBar
							value={healthStats.diskUsagePercent}
							label="Disk"
							icon={<HardDrive className="size-4" />}
						/>
					</div>
				)}

				{(networkHealth || containerHealth || agentHealth) && (
					<>
						<Separator />
						<div className="grid gap-4 sm:grid-cols-3">
							<HealthIndicator
								healthy={networkHealth?.tunnelUp}
								label="Network"
								detail={`${networkHealth?.peerCount ?? 0} peers`}
								icon={<Network className="size-4" />}
							/>
							<HealthIndicator
								healthy={containerHealth?.runtimeResponsive}
								label="Containers"
								detail={`${containerHealth?.runningContainers ?? 0} running`}
								icon={<Container className="size-4" />}
							/>
							<HealthIndicator
								healthy={!!agentHealth}
								label="Agent"
								detail={
									agentHealth?.version ? `v${agentHealth.version}` : "Unknown"
								}
								icon={<Activity className="size-4" />}
							/>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
