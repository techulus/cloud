import { Box } from "lucide-react";
import Link from "next/link";
import { ClusterHealthSummary } from "@/components/cluster/cluster-health-summary";
import {
	SUMMARY_CARD_CLASSNAME,
	SUMMARY_CARD_COMPACT_CLASSNAME,
	SUMMARY_CARD_COMPACT_TEXT_CLASSNAME,
	SUMMARY_CARD_COMPACT_TITLE_CLASSNAME,
	SUMMARY_CARD_GRID_CLASSNAME,
	SummaryCardStat,
	SummaryCardTitle,
	SummaryCardValue,
} from "@/components/core/summary-card";
import { CreateProjectDialog } from "@/components/project/create-project-dialog";
import { CreateServerDialog } from "@/components/server/create-server-dialog";
import { ServerList } from "@/components/server/server-list";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { getClusterHealth, listProjects, listServers } from "@/db/queries";
import { cn } from "@/lib/utils";

export default async function DashboardPage() {
	const [servers, projects, clusterHealth] = await Promise.all([
		listServers(),
		listProjects(),
		getClusterHealth(),
	]);

	return (
		<div className="container max-w-7xl mx-auto px-4 py-4 space-y-8 sm:py-6 sm:space-y-12">
			<div className="space-y-4 sm:space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-semibold">Projects</h2>
						<p className="hidden text-sm text-muted-foreground sm:block">
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
					<div className={SUMMARY_CARD_GRID_CLASSNAME}>
						{projects.map((project) => (
							<Link
								key={project.id}
								href={`/dashboard/projects/${project.slug}/production`}
								className={cn(
									SUMMARY_CARD_CLASSNAME,
									SUMMARY_CARD_COMPACT_CLASSNAME,
								)}
							>
								<SummaryCardTitle
									className={SUMMARY_CARD_COMPACT_TITLE_CLASSNAME}
								>
									{project.name}
								</SummaryCardTitle>
								<div className="mt-auto pt-2 sm:pt-3">
									<SummaryCardStat
										label="services"
										className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
									>
										<SummaryCardValue
											className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
										>
											{project.serviceCount === 0 ? (
												<span className="font-normal text-muted-foreground">
													none
												</span>
											) : (
												<>
													{project.onlineServiceCount}/{project.serviceCount}{" "}
													<span className="hidden font-normal text-muted-foreground sm:inline">
														online
													</span>
												</>
											)}
										</SummaryCardValue>
									</SummaryCardStat>
									<SummaryCardStat
										label="environments"
										className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
									>
										<SummaryCardValue
											className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
										>
											{project.environmentCount}
										</SummaryCardValue>
									</SummaryCardStat>
								</div>
							</Link>
						))}
					</div>
				)}
			</div>

			<div className="space-y-4 sm:space-y-6">
				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0 space-y-1">
						<h2 className="text-lg font-semibold">Servers</h2>
						{servers.length > 0 ? (
							<ClusterHealthSummary initialData={clusterHealth} />
						) : (
							<p className="text-sm text-muted-foreground">
								Real-time infrastructure status and fleet management
							</p>
						)}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<CreateServerDialog />
					</div>
				</div>

				<ServerList initialServers={servers} showHeader={false} />
			</div>
		</div>
	);
}
