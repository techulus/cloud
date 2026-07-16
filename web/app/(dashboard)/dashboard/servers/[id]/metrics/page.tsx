import { ServerMetricsPage } from "@/components/server/server-metrics-page";

export default async function MetricsPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	return (
		<div className="container max-w-7xl mx-auto px-4 py-2">
			<ServerMetricsPage serverId={id} />
		</div>
	);
}
