"use client";

import useSWR from "swr";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CreateServerDialog } from "@/components/create-server-dialog";
import { PageHeader } from "@/components/page-header";
import { Settings } from "lucide-react";

type Server = {
	id: string;
	name: string;
	publicIp: string | null;
	wireguardIp: string | null;
	status: string;
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

function StatusBadge({ status }: { status: string }) {
	const variants: Record<
		string,
		"default" | "secondary" | "destructive" | "outline"
	> = {
		online: "default",
		pending: "secondary",
		offline: "destructive",
		unknown: "outline",
	};

	return <Badge variant={variants[status] || "outline"}>{status}</Badge>;
}

export function ServerList({ initialServers }: { initialServers: Server[] }) {
	const { data: servers } = useSWR<Server[]>("/api/servers", fetcher, {
		fallbackData: initialServers,
		refreshInterval: 10000,
		revalidateOnFocus: true,
	});

	return (
		<div className="space-y-6">
			<PageHeader
				title="Servers"
				description="Manage your server fleet"
				actions={
					<div className="flex gap-2">
						<Link href="/dashboard/proxy">
							<Button variant="outline">
								<Settings className="h-4 w-4 mr-1" />
								Proxy
							</Button>
						</Link>
						<CreateServerDialog />
					</div>
				}
			/>

			{!servers || servers.length === 0 ? (
				<Card>
					<CardContent className="py-10 text-center">
						<p className="text-muted-foreground mb-4">
							No servers yet. Add your first server to get started.
						</p>
						<CreateServerDialog />
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{servers.map((server) => (
						<Link key={server.id} href={`/dashboard/servers/${server.id}`}>
							<Card className="hover:bg-muted/50 transition-colors cursor-pointer">
								<CardHeader className="min-h-24">
									<div className="flex items-center justify-between">
										<CardTitle>{server.name}</CardTitle>
										<StatusBadge status={server.status} />
									</div>
									<div className="text-sm text-muted-foreground space-y-1 pt-1">
									<div>
										<span className="font-medium">WireGuard:</span>{" "}
										{server.wireguardIp || "Not registered"}
									</div>
									{server.publicIp && (
										<div>
											<span className="font-medium">Public:</span>{" "}
											{server.publicIp}
										</div>
									)}
								</div>
								</CardHeader>
							</Card>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
