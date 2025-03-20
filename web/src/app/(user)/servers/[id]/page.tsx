import { ServerConfigTabs } from "@/components/servers/server-config-tabs";
import db from "@/db";
import { server } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";

export default async function ServerPage({
	params,
}: { params: Promise<{ id: string }> }) {
	const { id } = await params;

	const { orgId } = await getOwner();

	const serverDetails = await db.query.server.findFirst({
		where: and(eq(server.id, id), eq(server.organizationId, orgId)),
	});

	if (!serverDetails) {
		return notFound();
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">{serverDetails.name}</h1>
			</div>

			<ServerConfigTabs serverDetails={serverDetails} />
		</div>
	);
}
