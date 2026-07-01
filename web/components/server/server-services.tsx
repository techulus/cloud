import Link from "next/link";
import { ArrowUpRight, Layers } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { getServerServices } from "@/db/queries";

export async function ServerServices({ serverId }: { serverId: string }) {
	const services = await getServerServices(serverId);

	if (services.length === 0) {
		return null;
	}

	const groups = groupServicesByProjectEnvironment(services);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Layers className="h-5 w-5" />
					Running Services
				</CardTitle>
				<CardDescription>
					{services.length} service{services.length !== 1 ? "s" : ""} deployed
					on this server
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-5">
					{groups.map((group) => (
						<div key={group.key} className="space-y-2">
							<div>
								<p className="font-medium text-sm">{group.projectName}</p>
								<p className="text-xs text-muted-foreground">
									{group.environmentName}
								</p>
							</div>
							<div className="divide-y rounded-lg border">
								{group.services.map((service) => (
									<Link
										key={service.serviceId}
										href={`/dashboard/projects/${service.projectSlug}/${service.environmentName}/services/${service.serviceId}`}
										className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted"
									>
										<span className="min-w-0 truncate font-medium">
											{service.serviceName}
										</span>
										<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
									</Link>
								))}
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

type ServerService = Awaited<ReturnType<typeof getServerServices>>[number];

function groupServicesByProjectEnvironment(services: ServerService[]) {
	const groups = new Map<
		string,
		{
			key: string;
			projectName: string;
			environmentName: string;
			services: ServerService[];
		}
	>();

	for (const service of services) {
		const key = `${service.projectId}:${service.environmentName}`;
		const group = groups.get(key) ?? {
			key,
			projectName: service.projectName,
			environmentName: service.environmentName,
			services: [],
		};

		group.services.push(service);
		groups.set(key, group);
	}

	return Array.from(groups.values());
}
