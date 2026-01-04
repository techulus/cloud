import { Box } from "lucide-react";
import Link from "next/link";
import { listProjects, listServers } from "@/db/queries";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { ServerList } from "@/components/server/server-list";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";

export default async function DashboardPage() {
	const [servers, projects] = await Promise.all([
		listServers(),
		listProjects(),
	]);

	return (
		<div className="pt-4 space-y-12">
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-semibold">Projects</h2>
						<p className="text-sm text-muted-foreground">
							Deploy and manage services
						</p>
					</div>
					<CreateProjectDialog />
				</div>

				{projects.length === 0 ? (
					<div className="py-10 text-center border rounded-lg">
						<p className="text-muted-foreground mb-4">
							No projects yet. Create your first project to deploy services.
						</p>
						<CreateProjectDialog />
					</div>
				) : (
					<ItemGroup className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{projects.map((project) => (
							<Item
								key={project.id}
								variant="outline"
								render={
									<Link
										href={`/dashboard/projects/${project.slug}/production`}
									/>
								}
							>
								<ItemMedia variant="icon">
									<Box className="size-5 text-muted-foreground" />
								</ItemMedia>
								<ItemContent>
									<ItemTitle>{project.name}</ItemTitle>
									<ItemDescription>
										{project.serviceCount === 0
											? "No services"
											: project.serviceCount === 1
												? "1 service"
												: `${project.serviceCount} services`}
									</ItemDescription>
								</ItemContent>
							</Item>
						))}
					</ItemGroup>
				)}
			</div>

			<ServerList initialServers={servers} />
		</div>
	);
}
