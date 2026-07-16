import { notFound } from "next/navigation";
import { ServerDangerZone } from "@/components/server/server-danger-zone";
import { getServerDetails } from "@/db/queries";

export default async function ServerSettingsPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const server = await getServerDetails(id);

	if (!server) {
		notFound();
	}

	return (
		<div className="mx-auto max-w-5xl px-4 py-2">
			<ServerDangerZone serverId={id} serverName={server.name} />
		</div>
	);
}
