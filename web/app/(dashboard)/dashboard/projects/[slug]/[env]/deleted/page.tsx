import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { DeletedServicesPanel } from "@/components/service/deleted-services-panel";
import { Button } from "@/components/ui/button";
import {
	getEnvironmentByName,
	getProjectBySlug,
	listDeletedServices,
} from "@/db/queries";

export default async function DeletedServicesPage({
	params,
}: {
	params: Promise<{ slug: string; env: string }>;
}) {
	const { slug, env: envName } = await params;
	const project = await getProjectBySlug(slug);

	if (!project) {
		notFound();
	}

	const environment = await getEnvironmentByName(project.id, envName);

	if (!environment) {
		notFound();
	}

	const deletedServices = await listDeletedServices(project.id, environment.id);
	const environmentHref = `/dashboard/projects/${slug}/${envName}`;

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: project.name, href: environmentHref },
					{ label: "Deleted services", href: `${environmentHref}/deleted` },
				]}
			/>
			<div className="container mx-auto max-w-4xl space-y-6 px-4 py-6">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h1 className="text-2xl font-semibold">Deleted services</h1>
						<p className="text-sm text-muted-foreground">
							Restore stateful services before their 7-day retention expires.
						</p>
					</div>
					<Link href={environmentHref}>
						<Button variant="outline">
							<ArrowLeft className="h-4 w-4" />
							Services
						</Button>
					</Link>
				</div>
				<DeletedServicesPanel services={deletedServices} />
			</div>
		</>
	);
}
