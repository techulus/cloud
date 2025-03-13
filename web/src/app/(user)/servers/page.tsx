import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { server } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { KeyIcon } from "@heroicons/react/16/solid";
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
					<Button href="/servers/new">Add Server</Button>
				</div>
			</div>

			{servers?.length ? (
				<div className="mt-8 relative min-h-[calc(90vh-12rem)] rounded-xl bg-zinc-50 dark:bg-zinc-800 flex flex-col">
					<div className="absolute inset-0 rounded-xl [background-size:40px_40px] [background-image:radial-gradient(circle,rgb(0_0_0/0.2)_1px,transparent_1px)] dark:[background-image:radial-gradient(circle,rgb(255_255_255/0.2)_1px,transparent_1px)]" />
					<div className="relative p-8 flex flex-col items-center justify-center flex-1 w-full gap-8">
						{servers.map((server) => (
							<div
								key={server.id}
								className="group w-full max-w-sm bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 transition-all duration-200 flex flex-col"
							>
								<div className="flex items-center justify-between">
									<h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
										{server.name}
									</h3>
								</div>
								<div className="mt-4 space-y-2">
									<div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400">
										<KeyIcon className="w-4 h-4" />
										<span className="ml-2">{server.token}</span>
									</div>
								</div>
							</div>
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
