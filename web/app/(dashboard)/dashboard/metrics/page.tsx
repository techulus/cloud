import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { MetricsHistoryCharts } from "@/components/metrics/metrics-history-charts";
import { listServers } from "@/db/queries";

export default async function MetricsPage() {
	const servers = await listServers();

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: "Metrics", href: "/dashboard/metrics" },
				]}
			/>
			<div className="container max-w-7xl mx-auto px-4 py-6 space-y-8">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
					<p className="text-sm text-muted-foreground">
						Cluster-level infrastructure health and historical resource usage
					</p>
				</div>

				<MetricsHistoryCharts
					endpoint="/api/cluster-metrics"
					title="Cluster History"
					description="CPU, memory, and disk usage by server"
					servers={servers.map((server) => ({
						id: server.id,
						name: server.name,
					}))}
				/>
			</div>
		</>
	);
}
