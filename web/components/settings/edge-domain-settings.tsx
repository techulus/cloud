import { Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import type { Server } from "@/db/types";

export type EdgeDomainOverview = {
	hostname: string | null;
	hostnameSource: "env" | "fallback" | "unconfigured";
};

export function EdgeDomainSettings({
	initial,
	servers,
}: {
	initial: EdgeDomainOverview;
	servers: Server[];
}) {
	const proxies = servers.filter((server) => server.isProxy);
	const ipv4Targets = [
		...new Set(
			proxies.flatMap((server) => (server.publicIp ? [server.publicIp] : [])),
		),
	].sort();

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Network className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Edge Domain</ItemTitle>
				</ItemContent>
			</Item>

			<div className="p-4 space-y-5">
				<div>
					<Label>Canonical hostname</Label>
					<div className="font-mono text-sm mt-1">
						{initial.hostname ?? "Not configured"}
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						{initial.hostnameSource === "env"
							? "Configured with EDGE_DOMAIN."
							: initial.hostnameSource === "fallback"
								? "Using the legacy Proxy Domain setting. Configure EDGE_DOMAIN to replace it."
								: "Set EDGE_DOMAIN on the control plane to configure the canonical hostname."}
					</p>
				</div>

				<div>
					<Label>DNS records for the canonical hostname</Label>
					<p className="text-sm text-muted-foreground mt-1">
						Create one A record for each proxy IPv4 address using your DNS
						provider and routing policy.
					</p>
					<div className="mt-3 rounded-md border divide-y">
						{initial.hostname && ipv4Targets.length > 0 ? (
							ipv4Targets.map((ip) => (
								<div
									key={ip}
									className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[4rem_1fr_1fr]"
								>
									<Badge variant="outline" className="w-fit font-mono">
										A
									</Badge>
									<span className="font-mono break-all">
										{initial.hostname}
									</span>
									<span className="font-mono break-all">{ip}</span>
								</div>
							))
						) : (
							<p className="px-3 py-2 text-sm text-muted-foreground">
								{initial.hostname
									? "No proxy IPv4 addresses are available."
									: "Configure EDGE_DOMAIN to see the required records."}
							</p>
						)}
					</div>
				</div>

				<div>
					<Label>Custom domains</Label>
					<ul className="mt-2 space-y-2 text-sm text-muted-foreground">
						<li>
							For subdomains, create a <code>CNAME</code> pointing to{" "}
							<code>{initial.hostname ?? "your EDGE_DOMAIN"}</code>.
						</li>
						<li>
							For apex domains, create an <code>ALIAS</code> or{" "}
							<code>ANAME</code> pointing to{" "}
							<code>{initial.hostname ?? "your EDGE_DOMAIN"}</code>.
						</li>
					</ul>
				</div>
			</div>
		</div>
	);
}
