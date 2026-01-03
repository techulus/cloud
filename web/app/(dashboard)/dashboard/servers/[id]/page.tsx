import { notFound } from "next/navigation";
import { getServerDetails } from "@/db/queries";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SetBreadcrumbData } from "@/components/core/breadcrumb-data";
import { StatusIndicator } from "@/components/core/status-indicator";
import { db } from "@/db";
import { workQueue } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/date";

export default async function ServerDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const [server, recentActions] = await Promise.all([
		getServerDetails(id),
		db
			.select()
			.from(workQueue)
			.where(eq(workQueue.serverId, id))
			.orderBy(desc(workQueue.createdAt))
			.limit(50),
	]);

	if (!server) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbData data={{ server: server.name }} />
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold">{server.name}</h1>
					<StatusIndicator status={server.status} />
				</div>

				<Card>
					<CardHeader>
						<CardTitle>Server Details</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
							<div>
								<p className="text-sm text-muted-foreground">Public IP</p>
								<p className="font-mono">{server.publicIp || "—"}</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">WireGuard IP</p>
								<p className="font-mono">{server.wireguardIp || "—"}</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Last Seen</p>
								<p>
									{server.lastHeartbeat
										? formatRelativeTime(server.lastHeartbeat)
										: "Never"}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">CPU</p>
								<p>
									{server.resourcesCpu !== null
										? `${server.resourcesCpu} cores`
										: "—"}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Memory</p>
								<p>
									{server.resourcesMemory !== null
										? `${Math.round((server.resourcesMemory / 1024) * 10) / 10} GB`
										: "—"}
								</p>
							</div>
							<div>
								<p className="text-sm text-muted-foreground">Disk</p>
								<p>
									{server.resourcesDisk !== null
										? `${server.resourcesDisk} GB`
										: "—"}
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Recent Actions</CardTitle>
					</CardHeader>
					<CardContent>
						{recentActions.length === 0 ? (
							<p className="text-sm text-muted-foreground">No actions yet</p>
						) : (
							<div className="space-y-3">
								{recentActions.map((action) => (
									<div key={action.id} className="py-3 border-b last:border-0">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-3">
												<Badge
													variant={
														action.status === "completed"
															? "default"
															: action.status === "failed"
																? "destructive"
																: action.status === "processing"
																	? "secondary"
																	: "outline"
													}
												>
													{action.status}
												</Badge>
												<span className="font-medium">{action.type}</span>
											</div>
											<span className="text-sm text-muted-foreground">
												{formatRelativeTime(action.createdAt)}
											</span>
										</div>
										<pre className="mt-2 p-2 bg-muted rounded text-xs overflow-x-auto">
											{JSON.stringify(JSON.parse(action.payload), null, 2)}
										</pre>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			</div>
		</>
	);
}
