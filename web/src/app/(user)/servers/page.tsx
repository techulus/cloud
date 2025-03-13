import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { server } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { eq } from "drizzle-orm";

export default async function Servers() {
	const { orgId } = await getOwner();

	const servers = await db.query.server.findMany({
		where: eq(server.organizationId, orgId),
	});

	return (
		<>
			<div className="flex w-full flex-wrap items-end justify-between gap-4 border-b border-zinc-950/10 pb-6 dark:border-white/10">
				<Heading>Servers</Heading>
				<div className="flex gap-4">
					<Button>Add Server</Button>
				</div>
			</div>

			{servers?.length ? (
				<div className="mt-8 relative min-h-[calc(90vh-12rem)] rounded-xl bg-zinc-50 dark:bg-zinc-800 flex flex-col">
					<div className="absolute inset-0 rounded-xl [background-size:40px_40px] [background-image:radial-gradient(circle,rgb(0_0_0/0.2)_1px,transparent_1px)] dark:[background-image:radial-gradient(circle,rgb(255_255_255/0.2)_1px,transparent_1px)]" />
					<div className="relative p-8 flex flex-col items-center justify-center flex-1 w-full">
						{servers.map((server) => (
							<div key={server.id}>{server.name}</div>
						))}
					</div>
				</div>
			) : (
				<div className="mt-8 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center bg-white dark:bg-zinc-800">
					<p className="text-zinc-500 dark:text-zinc-400">
						No servers found. Add your first server to get started.
					</p>
				</div>
			)}
		</>
	);
}
