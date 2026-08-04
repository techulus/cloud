import { notFound } from "next/navigation";
import { ServerSecurityPage } from "@/components/server/server-security-page";
import { getServerDetails } from "@/db/queries";

export default async function SecurityPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const server = await getServerDetails(id);

	if (!server?.isProxy) {
		notFound();
	}

	return (
		<div className="container mx-auto max-w-7xl px-4 py-2">
			<ServerSecurityPage
				serverId={server.id}
				initialServerStatus={server.status}
				initialHealth={server.crowdsecHealth ?? null}
			/>
		</div>
	);
}
