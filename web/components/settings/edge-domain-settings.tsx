"use client";

import { Globe, Network } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	updateAutoSubdomainDomain,
	updateEdgeDomain,
} from "@/actions/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import type { Server } from "@/db/types";

export type EdgeDomainOverview = {
	hostname: string | null;
};

export function EdgeDomainSettings({
	initial,
	initialAutoSubdomainDomain,
	servers,
}: {
	initial: EdgeDomainOverview;
	initialAutoSubdomainDomain: string | null;
	servers: Server[];
}) {
	const router = useRouter();
	const [domain, setDomain] = useState(initial.hostname ?? "");
	const [autoSubdomainDomain, setAutoSubdomainDomain] = useState(
		initialAutoSubdomainDomain ?? "",
	);
	const [isSaving, setIsSaving] = useState(false);
	const [isSavingAutoSubdomain, setIsSavingAutoSubdomain] = useState(false);
	const proxies = servers.filter((server) => server.isProxy);
	const ipv4Targets = [
		...new Set(
			proxies.flatMap((server) => (server.publicIp ? [server.publicIp] : [])),
		),
	].sort();
	const hasChanges = domain !== (initial.hostname ?? "");
	const autoSubdomainHasChanges =
		autoSubdomainDomain !== (initialAutoSubdomainDomain ?? "");

	const handleSave = async () => {
		setIsSaving(true);
		try {
			const result = await updateEdgeDomain(domain);
			setDomain(result.hostname);
			toast.success("Edge domain updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update edge domain",
			);
		} finally {
			setIsSaving(false);
		}
	};

	const handleSaveAutoSubdomain = async () => {
		setIsSavingAutoSubdomain(true);
		try {
			const result = await updateAutoSubdomainDomain(autoSubdomainDomain);
			setAutoSubdomainDomain(result.hostname);
			toast.success("Automatic subdomain domain updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update automatic subdomain domain",
			);
		} finally {
			setIsSavingAutoSubdomain(false);
		}
	};

	return (
		<>
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
					<div className="space-y-2">
						<Label htmlFor="edge-domain">Canonical hostname</Label>
						<Input
							id="edge-domain"
							value={domain}
							onChange={(event) => setDomain(event.target.value)}
							placeholder="edge.example.com"
						/>
						<p className="text-xs text-muted-foreground mt-1">
							Used for HTTP/HTTPS custom domains and direct TCP/UDP connection
							strings.
						</p>
						{hasChanges && (
							<div className="pt-2">
								<Button onClick={handleSave} disabled={isSaving} size="sm">
									{isSaving ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>

					<div>
						<Label>Proxy origin addresses</Label>
						<p className="text-sm text-muted-foreground mt-1">
							Configure these addresses as origins behind your external load
							balancer. A stable external load balancer with active health
							checks is the ideal production solution for proxy failure.
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							A direct A record to one proxy has no ingress failover. Multiple A
							records provide best-effort distribution, but clients may continue
							using an offline proxy because of DNS caching.
						</p>
						<div className="mt-3 rounded-md border divide-y">
							{initial.hostname && ipv4Targets.length > 0 ? (
								ipv4Targets.map((ip) => (
									<div
										key={ip}
										className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[4rem_1fr_1fr]"
									>
										<Badge variant="outline" className="w-fit font-mono">
											IP
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
										: "Configure an edge domain to see the required records."}
								</p>
							)}
						</div>
					</div>

					<div>
						<Label>Custom domains</Label>
						<ul className="mt-2 space-y-2 text-sm text-muted-foreground">
							<li>
								For subdomains, create a <code>CNAME</code> pointing to{" "}
								<code>{initial.hostname ?? "your edge domain"}</code>.
							</li>
							<li>
								For apex domains, create an <code>ALIAS</code> or{" "}
								<code>ANAME</code> pointing to{" "}
								<code>{initial.hostname ?? "your edge domain"}</code>.
							</li>
						</ul>
					</div>
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Globe className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Automatic Subdomain Domain</ItemTitle>
					</ItemContent>
				</Item>

				<div className="p-4 space-y-4">
					<div className="space-y-2">
						<Label htmlFor="auto-subdomain-domain">Base domain</Label>
						<Input
							id="auto-subdomain-domain"
							value={autoSubdomainDomain}
							onChange={(event) => setAutoSubdomainDomain(event.target.value)}
							placeholder="apps.example.com"
						/>
						<p className="text-xs text-muted-foreground">
							Enables automatic service domains such as{" "}
							<code>service.apps.example.com</code> in Networking settings.
						</p>
						{autoSubdomainHasChanges && (
							<div className="pt-2">
								<Button
									onClick={handleSaveAutoSubdomain}
									disabled={isSavingAutoSubdomain}
									size="sm"
								>
									{isSavingAutoSubdomain ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>

					<p className="text-sm text-muted-foreground">
						Create a wildcard CNAME record for{" "}
						<code>
							*.
							{initialAutoSubdomainDomain ?? "your automatic subdomain domain"}
						</code>{" "}
						that points to the edge domain. In production, the edge domain
						should resolve to a stable external load balancer with active health
						checks.
					</p>
				</div>
			</div>
		</>
	);
}
