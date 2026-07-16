import { notFound } from "next/navigation";
import { AgentUpdateNudge } from "@/components/server/agent-update-nudge";
import { ServerDetailsOverview } from "@/components/server/server-details-overview";
import { ServerServices } from "@/components/server/server-services";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { getServerDetails } from "@/db/queries";
import { queryNodeMetricsSnapshot } from "@/lib/victoria-metrics";

async function getLatestAgentVersion(): Promise<string | null> {
	try {
		const res = await fetch(
			"https://api.github.com/repos/techulus/cloud/releases/latest",
			{
				headers: { Accept: "application/vnd.github.v3+json" },
			},
		);
		if (!res.ok) return null;
		const data = await res.json();
		return data.tag_name ?? null;
	} catch {
		return null;
	}
}

export default async function ServerDetailPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const [server, latestVersion, metricsSnapshot] = await Promise.all([
		getServerDetails(id),
		getLatestAgentVersion(),
		queryNodeMetricsSnapshot(id).catch(() => null),
	]);

	if (!server) {
		notFound();
	}

	const isUnregistered = !server.wireguardIp && server.agentToken;
	const currentVersion = server.agentHealth?.version;
	const hasUpdate =
		currentVersion && latestVersion && currentVersion !== latestVersion;

	return (
		<div className="space-y-6 px-4 py-2">
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
								{`sudo CONTROL_PLANE_URL=${process.env.APP_URL} REGISTRATION_TOKEN=${server.agentToken} bash -c "$(curl -fsSL ${process.env.APP_URL}/setup.sh)"`}
							</code>
						</div>
					</CardContent>
				</Card>
			)}

			<div>
				<ServerDetailsOverview
					server={{
						id: server.id,
						name: server.name,
						status: server.status,
						isProxy: server.isProxy,
						publicIp: server.publicIp,
						privateIp: server.privateIp,
						wireguardIp: server.wireguardIp,
						lastHeartbeat: server.lastHeartbeat,
						resourcesCpu: server.resourcesCpu,
						resourcesMemory: server.resourcesMemory,
						resourcesDisk: server.resourcesDisk,
						meta: server.meta,
						networkHealth: server.networkHealth,
						containerHealth: server.containerHealth,
						agentHealth: server.agentHealth,
					}}
					initialMetrics={metricsSnapshot}
				/>

				{hasUpdate && (
					<AgentUpdateNudge
						serverId={id}
						currentVersion={currentVersion}
						latestVersion={latestVersion}
						serverStatus={server.status}
						upgradeStatus={server.agentUpgradeStatus}
						upgradeTargetVersion={server.agentUpgradeTargetVersion}
						upgradeError={server.agentUpgradeError}
					/>
				)}
			</div>

			<div className="mx-auto max-w-5xl">
				<ServerServices serverId={id} />
			</div>
		</div>
	);
}
