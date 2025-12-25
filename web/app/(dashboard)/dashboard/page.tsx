import Link from "next/link";
import { listServers } from "@/actions/servers";
import { listProjects } from "@/actions/projects";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ServerList } from "@/components/server-list";
import { PageHeader } from "@/components/page-header";
import { CreateProjectDialog } from "@/components/create-project-dialog";

export default async function DashboardPage() {
	const [servers, projects] = await Promise.all([
		listServers(),
		listProjects(),
	]);

	return (
		<div className="space-y-8">
			<div className="space-y-6">
				<PageHeader
					title="Projects"
					description="Deploy and manage services"
					actions={<CreateProjectDialog />}
				/>

				{projects.length === 0 ? (
					<Card>
						<CardContent className="py-10 text-center">
							<p className="text-muted-foreground mb-4">
								No projects yet. Create your first project to deploy services.
							</p>
							<CreateProjectDialog />
						</CardContent>
					</Card>
				) : (
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{projects.map((project) => (
							<Link
								key={project.id}
								href={`/dashboard/projects/${project.slug}`}
							>
								<Card className="hover:bg-muted/50 transition-colors cursor-pointer">
									<CardHeader className="min-h-24">
										<CardTitle>{project.name}</CardTitle>
										<CardDescription>
											{project.serviceCount === 0
												? "No services"
												: project.serviceCount === 1
													? "1 service"
													: `${project.serviceCount} services`}
										</CardDescription>
									</CardHeader>
								</Card>
							</Link>
						))}
					</div>
				)}
			</div>

			<ServerList initialServers={servers} />
		</div>
	);
}
