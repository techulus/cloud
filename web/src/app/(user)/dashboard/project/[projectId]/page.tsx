import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { project, service } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { PlusIcon } from "@heroicons/react/16/solid";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ServiceItem } from "@/components/services/service-item";

export default async function ProjectServices({
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

	const services = await db.query.service.findMany({
		where: eq(service.projectId, projectDetails.id),
	});

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
				<div className="mt-8 relative min-h-[calc(90vh-12rem)] rounded-xl bg-zinc-50 dark:bg-zinc-800 flex flex-col">
					<div className="absolute inset-0 rounded-xl [background-size:40px_40px] [background-image:radial-gradient(circle,rgb(0_0_0/0.1)_1px,transparent_1px)] dark:[background-image:radial-gradient(circle,rgb(255_255_255/0.1)_1px,transparent_1px)]" />
					<div className="relative p-8 flex flex-col items-center justify-center flex-1 w-full">
						{services.map((service) => (
							<ServiceItem key={service.id} item={service} />
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
