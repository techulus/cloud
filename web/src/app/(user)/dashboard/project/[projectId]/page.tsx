import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { project, service } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { PlusIcon } from "@heroicons/react/16/solid";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { deployService } from "../../actions";

export default async function Project({
	params,
}: { params: Promise<{ projectId: string }> }) {
	const { projectId } = await params;
	const { orgId } = await getOwner();
	const projectDetails = await db.query.project.findFirst({
		where: and(eq(project.id, projectId), eq(project.organizationId, orgId)),
	});

	if (!projectDetails) {
		notFound();
	}

	const services = await db.query.service
		.findMany({
			where: eq(service.projectId, projectDetails.id),
		})
		.then((services) =>
			services.map((service) => ({
				...service,
				configuration: JSON.parse(service.configuration || "{}"),
			})),
		);

	return (
		<>
			<div className="flex w-full flex-wrap items-end justify-between gap-4 border-b border-zinc-950/10 pb-6 dark:border-white/10">
				<Heading>{projectDetails.name}</Heading>
				<div className="flex gap-4">
					<Button outline>Invite</Button>
					<Button href={`/dashboard/project/${projectDetails.id}/new`}>
						<PlusIcon />
						Add Service
					</Button>
				</div>
			</div>

			{services?.length ? (
				<div className="mt-8 relative min-h-[calc(90vh-12rem)] rounded-xl bg-zinc-50 dark:bg-zinc-800">
					<div className="absolute inset-0 rounded-xl [background-size:40px_40px] [background-image:radial-gradient(circle,rgb(0_0_0/0.1)_1px,transparent_1px)] dark:[background-image:radial-gradient(circle,rgb(255_255_255/0.1)_1px,transparent_1px)]" />

					<div className="relative p-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 content-center justify-items-center min-h-full">
						{services.map((service) => (
							<div
								key={service.id}
								className="group w-full max-w-sm bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 hover:shadow-lg transition-all duration-200 flex flex-col"
							>
								<div className="flex-1">
									<div className="flex items-center justify-between">
										<h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
											{service.name}
										</h3>
										<div className="h-2 w-2 rounded-full bg-green-500" />
									</div>
									<div className="mt-4 space-y-2">
										<div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400">
											<span className="font-medium">Image:</span>
											<span className="ml-2">
												{service.configuration?.image}
											</span>
										</div>
									</div>
								</div>
								<form
									action={async () => {
										"use server";
										await deployService({
											serviceId: service.id,
										});
									}}
									className="mt-6"
								>
									<Button type="submit" className="w-full">
										Deploy
									</Button>
								</form>
							</div>
						))}
					</div>
				</div>
			) : (
				<div className="mt-8 rounded-xl border border-zinc-200 dark:border-zinc-700 p-8 text-center bg-white dark:bg-zinc-800">
					<p className="text-zinc-500 dark:text-zinc-400">
						No services found. Add your first service to get started.
					</p>
				</div>
			)}
		</>
	);
}
