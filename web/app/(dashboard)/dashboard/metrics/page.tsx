import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { MetricsHistoryCharts } from "@/components/metrics/metrics-history-charts";

export default async function MetricsPage() {
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
					description="Average CPU, memory, and disk usage across reporting servers"
					scope="cluster"
				/>
			</div>
		</>
	);
}
