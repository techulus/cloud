import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import db from "@/db";
import { project, service } from "@/db/schema";
import { getOwner } from "@/lib/user";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ServiceDetailTabs } from "@/components/services/service-detail-tabs";
import { deployService } from "../../../actions";

export default async function ServiceDetailsLayout({
	params,
	children,
}: {
	params: Promise<{ projectId: string; serviceId: string }>;
	children: React.ReactNode;
}) {
	const { projectId, serviceId } = await params;

	const { orgId } = await getOwner();
	const projectDetails = await db.query.project.findFirst({
		where: and(eq(project.id, projectId), eq(project.organizationId, orgId)),
	});

	if (!projectDetails) {
		notFound();
	}

	const serviceDetails = await db.query.service.findFirst({
		where: and(
			eq(service.projectId, projectDetails.id),
			eq(service.id, serviceId),
		),
	});

	if (!serviceDetails) {
		notFound();
	}

	return (
		<>
			<div className="flex w-full flex-wrap items-end justify-between gap-4 pb-6">
				<Heading>
					<Link href={`/dashboard/project/${projectId}`}>
						{projectDetails.name}
					</Link>{" "}
					/ {serviceDetails.name}
				</Heading>
				<div className="flex gap-4">
					<form
						action={async () => {
							"use server";
							await deployService({ serviceId });
						}}
					>
						<Button type="submit" outline>
							Redeploy
						</Button>
					</form>
					<Button>Restart</Button>
				</div>
			</div>

			<ServiceDetailTabs projectId={projectId} serviceId={serviceId} />

			<div className="mt-6">{children}</div>
		</>
	);
}
