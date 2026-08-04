"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";

type ClusterHealthData = {
	summary: {
		totalServers: number;
		onlineServers: number;
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

	const anyOnline = summary.onlineServers > 0;

	const stats = [
		{
			label: "servers",
			value: `${summary.onlineServers}/${summary.totalServers}`,
			subtitle: "online",
			healthy:
				summary.totalServers > 0 &&
				summary.onlineServers === summary.totalServers,
		},
		{
			label: "tunnels",
			value: `${summary.networkHealthy}/${summary.onlineServers}`,
			subtitle: "connected",
			healthy: anyOnline && summary.networkHealthy === summary.onlineServers,
		},
		{
			label: "runtimes",
			value: `${summary.containerHealthy}/${summary.onlineServers}`,
			subtitle: "responsive",
			healthy: anyOnline && summary.containerHealthy === summary.onlineServers,
		},
	];

	const degraded = stats.filter((stat) => !stat.healthy);

	if (degraded.length === 0) {
		return (
			<div className="flex items-center gap-1.5 text-sm">
				<span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
				<span className="text-muted-foreground">All systems operational</span>
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
			{degraded.map((stat) => (
				<div key={stat.label} className="flex items-center gap-1.5">
					<span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
					<span className="font-semibold tabular-nums text-foreground">
						{stat.value}
					</span>
					<span className="text-muted-foreground">
						{stat.label} {stat.subtitle}
					</span>
				</div>
			))}
		</div>
	);
}
