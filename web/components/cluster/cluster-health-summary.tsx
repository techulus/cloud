"use client";

import { Activity, Cpu, Network, Server } from "lucide-react";
import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { fetcher } from "@/lib/fetcher";

type ClusterHealthData = {
	summary: {
		totalServers: number;
		onlineServers: number;
		avgCpuUsage: number;
		avgMemoryUsage: number;
		networkHealthy: number;
		containerHealthy: number;
	};
};

interface ClusterHealthSummaryProps {
	initialData: ClusterHealthData;
}

export function ClusterHealthSummary({
	initialData,
}: ClusterHealthSummaryProps) {
	const { data } = useSWR<ClusterHealthData>("/api/cluster-health", fetcher, {
		fallbackData: initialData,
		refreshInterval: 10000,
	});

	const summary = data?.summary ?? initialData.summary;

	const stats = [
		{
			label: "Servers Online",
			value: `${summary.onlineServers}/${summary.totalServers}`,
			icon: Server,
			healthy: summary.onlineServers === summary.totalServers,
		},
		{
			label: "Avg CPU",
			value: `${summary.avgCpuUsage.toFixed(1)}%`,
			icon: Cpu,
			healthy: summary.avgCpuUsage < 80,
		},
		{
			label: "Network Health",
			value: `${summary.networkHealthy}/${summary.onlineServers}`,
			icon: Network,
			healthy: summary.networkHealthy === summary.onlineServers,
		},
		{
			label: "Containers",
			value: `${summary.containerHealthy}/${summary.onlineServers}`,
			icon: Activity,
			healthy: summary.containerHealthy === summary.onlineServers,
		},
	];

	return (
		<div className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold">Cluster Health</h2>
				<p className="text-sm text-muted-foreground">
					Real-time infrastructure status
				</p>
			</div>
			<div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
				{stats.map((stat) => (
					<Card key={stat.label} size="sm">
						<CardContent className="flex items-center gap-3">
							<div
								className={`p-2 rounded-md ${
									stat.healthy
										? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
										: "bg-amber-500/10 text-amber-600 dark:text-amber-400"
								}`}
							>
								<stat.icon className="size-4" />
							</div>
							<div>
								<p className="text-xs text-muted-foreground">{stat.label}</p>
								<p className="text-lg font-semibold tabular-nums">
									{stat.value}
								</p>
							</div>
						</CardContent>
					</Card>
				))}
			</div>
		</div>
	);
}
