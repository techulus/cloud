import { LogViewer } from "@/components/logs/log-viewer";

export default async function ServerLogsPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;

	return (
		<div className="px-4 py-2">
			<LogViewer variant="server-logs" serverId={id} />
		</div>
	);
}
