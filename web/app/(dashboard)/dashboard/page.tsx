import { Box } from "lucide-react";
import Link from "next/link";
import { listProjects, listServers } from "@/db/queries";
import { CreateProjectDialog } from "@/components/project/create-project-dialog";
import { ServerList } from "@/components/server/server-list";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
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
		<div className="container max-w-7xl mx-auto px-4 py-6 space-y-12">
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
					<Empty className="border py-10">
						<EmptyMedia variant="icon">
							<Box />
						</EmptyMedia>
						<EmptyTitle>No projects yet</EmptyTitle>
						<EmptyDescription>
							Create your first project to deploy services.
						</EmptyDescription>
						<EmptyContent>
							<CreateProjectDialog />
						</EmptyContent>
					</Empty>
				) : (
					<ItemGroup className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{projects.map((project) => (
							<Item
								key={project.id}
								variant="outline"
								className="min-h-[80px]"
								render={
									<Link
										href={`/dashboard/projects/${project.slug}/production`}
									/>
								}
							>
								<ItemMedia variant="icon">
									<Box className="size-5 text-muted-foreground" />
								</ItemMedia>
								<ItemContent className="h-full justify-between">
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
