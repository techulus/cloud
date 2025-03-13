import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { getOwner } from "@/lib/user";
import { PlusIcon } from "@heroicons/react/16/solid";
import { eq } from "drizzle-orm";
import { project } from "@/db/schema";

export default async function Dashboard() {
	const { orgId } = await getOwner();
	const projects = await db.query.project.findMany({
		where: eq(project.organizationId, orgId),
	});

	return (
		<>
			<div className="flex w-full flex-wrap items-end justify-between gap-4 border-b border-zinc-950/10 pb-6 dark:border-white/10">
				<Heading>Dashboard</Heading>
				<div className="flex gap-4">
					<Button outline>Invite</Button>
					<Button href="/dashboard/project/new">
						<PlusIcon />
						New
					</Button>
				</div>
			</div>

			{projects?.length ? (
				<div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{projects.map((project) => (
						<div
							key={project.id}
							className="group relative bg-white dark:bg-zinc-800 rounded-xl border border-zinc-200 dark:border-zinc-700 p-6 hover:shadow-lg transition-all duration-200 flex flex-col"
						>
							<div>
								<h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
									<a
										href={`/dashboard/project/${project.id}`}
										className="focus:outline-none"
									>
										<span aria-hidden="true" className="absolute inset-0" />
										{project.name}
									</a>
								</h3>
								<p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
									0 services
								</p>
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="mt-8">
					<p className="text-sm text-zinc-500 dark:text-zinc-400">
						No projects found
					</p>
				</div>
			)}
		</>
	);
}
