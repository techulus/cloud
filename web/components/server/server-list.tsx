"use client";

import Link from "next/link";
import useSWR from "swr";
import { StatusIndicator } from "@/components/core/status-indicator";
import { CreateServerDialog } from "@/components/create-server-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Server } from "@/db/types";
import { fetcher } from "@/lib/fetcher";

type ServerWithIp = Pick<
	Server,
	"id" | "name" | "publicIp" | "wireguardIp" | "status"
>;

export function ServerList({
	initialServers,
}: {
	initialServers: ServerWithIp[];
}) {
	const { data: servers } = useSWR<ServerWithIp[]>("/api/servers", fetcher, {
		fallbackData: initialServers,
		refreshInterval: 10000,
		revalidateOnFocus: true,
	});

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold">Servers</h2>
					<p className="text-sm text-muted-foreground">
						Manage your server fleet
					</p>
				</div>
				<CreateServerDialog />
			</div>

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
								<CardHeader>
									<div className="flex items-center justify-between">
										<CardTitle>{server.name}</CardTitle>
										<StatusIndicator status={server.status} />
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
