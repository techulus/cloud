"use client";

import {
	Activity,
	AlertTriangle,
	Container,
	Cpu,
	HardDrive,
	MemoryStick,
	Network,
} from "lucide-react";
import useSWR from "swr";
import { HealthIndicator } from "@/components/cluster/health-indicator";
import { ResourceBar } from "@/components/cluster/resource-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { HealthStats, Server } from "@/db/types";
import { fetcher } from "@/lib/fetcher";

type ServerHealthData = {
	healthStats: HealthStats | null;
	networkHealth: Server["networkHealth"];
	containerHealth: Server["containerHealth"];
	agentHealth: Server["agentHealth"];
	agentCompatibilityStatus: "compatible" | "upgrade_required" | null;
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
	const agentCompatibilityStatus =
		serverData?.agentCompatibilityStatus ??
		initialData.agentCompatibilityStatus;
	const reconciliationFailures = agentHealth?.reconciliationFailures ?? [];

	if (!healthStats && !networkHealth && !containerHealth && !agentHealth) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>System Health</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{agentCompatibilityStatus === "upgrade_required" && (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertTitle>Agent upgrade required</AlertTitle>
						<AlertDescription>
							This agent is incompatible with the current deployment protocol.
							It will keep its cached state but cannot receive updates until it
							is upgraded.
						</AlertDescription>
					</Alert>
				)}
				{reconciliationFailures.length > 0 && (
					<Alert className="border-amber-500/50 bg-amber-500/5 text-amber-700 dark:text-amber-400">
						<AlertTriangle />
						<AlertTitle>Reconciliation delayed</AlertTitle>
						<AlertDescription>
							{reconciliationFailures.length} action
							{reconciliationFailures.length === 1 ? " is" : "s are"} being
							retried without blocking other server updates. Latest:{" "}
							{reconciliationFailures[0]?.description} (
							{reconciliationFailures[0]?.lastError}).
						</AlertDescription>
					</Alert>
				)}
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
								healthy={
									!!agentHealth &&
									agentCompatibilityStatus !== "upgrade_required"
								}
								label="Agent"
								detail={
									agentCompatibilityStatus === "upgrade_required"
										? "Upgrade required"
										: (agentHealth?.version ?? "Unknown")
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
