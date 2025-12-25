import Link from "next/link";
import { listServers } from "@/actions/servers";
import { listProjects } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ServerList } from "@/components/server-list";

export default async function DashboardPage() {
	const [servers, projects] = await Promise.all([
		listServers(),
		listProjects(),
	]);

	return (
		<div className="space-y-8">
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-2xl font-bold">Projects</h2>
						<p className="text-muted-foreground">Deploy and manage services</p>
					</div>
					<Link href="/dashboard/projects/new">
						<Button>New Project</Button>
					</Link>
				</div>

				{projects.length === 0 ? (
					<Card>
						<CardContent className="py-10 text-center">
							<p className="text-muted-foreground mb-4">
								No projects yet. Create your first project to deploy services.
							</p>
							<Link href="/dashboard/projects/new">
								<Button>New Project</Button>
							</Link>
						</CardContent>
					</Card>
				) : (
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						{projects.map((project) => (
							<Link key={project.id} href={`/dashboard/projects/${project.id}`}>
								<Card className="hover:bg-muted/50 transition-colors cursor-pointer">
									<CardHeader>
										<CardTitle>{project.name}</CardTitle>
										<CardDescription>{project.slug}</CardDescription>
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
