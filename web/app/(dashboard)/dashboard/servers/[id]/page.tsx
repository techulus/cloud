import { notFound } from "next/navigation";
import { getServerDetails } from "@/db/queries";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { SetBreadcrumbData } from "@/components/core/breadcrumb-data";
import { StatusIndicator } from "@/components/core/status-indicator";
import { formatRelativeTime } from "@/lib/date";
import { LogViewer } from "@/components/log-viewer";
import { Label } from "@/components/ui/label";

export default async function ServerDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const server = await getServerDetails(id);

	if (!server) {
		notFound();
	}

	const isUnregistered = !server.wireguardIp && server.agentToken;

	return (
		<>
			<SetBreadcrumbData data={{ server: server.name }} />
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold">{server.name}</h1>
					<StatusIndicator status={server.status} />
				</div>

				{isUnregistered && (
					<Card className="border-amber-500/50 bg-amber-500/5">
						<CardHeader>
							<CardTitle>Complete Server Setup</CardTitle>
							<CardDescription>
								Run the following command on your server to install and register
								the agent
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<div className="space-y-2">
								<Label>Agent Token</Label>
								<code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
									{server.agentToken}
								</code>
								<p className="text-xs text-muted-foreground">
									This token expires in 24 hours and can only be used once.
								</p>
							</div>
							<div className="space-y-2">
								<Label>Install Command</Label>
								<code className="block p-3 bg-muted rounded-lg text-sm break-all font-mono">
									sudo CONTROL_PLANE_URL={process.env.NEXT_PUBLIC_APP_URL}{" "}
									REGISTRATION_TOKEN={server.agentToken} bash -c &quot;$(curl
									-fsSL {process.env.NEXT_PUBLIC_APP_URL}/install.sh)&quot;
								</code>
							</div>
						</CardContent>
					</Card>
				)}

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

				<div className="space-y-2">
					<h3 className="text-sm font-medium">Agent Logs</h3>
					<LogViewer variant="server-logs" serverId={id} />
				</div>
			</div>
		</>
	);
}
