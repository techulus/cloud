"use client";

import { Server as ServerIcon } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { StatusIndicator } from "@/components/core/status-indicator";
import { CreateServerDialog } from "@/components/create-server-dialog";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
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
				<div className="py-10 text-center border rounded-lg">
					<p className="text-muted-foreground mb-4">
						No servers yet. Add your first server to get started.
					</p>
					<CreateServerDialog />
				</div>
			) : (
				<ItemGroup className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{servers.map((server) => (
						<Item
							key={server.id}
							variant="outline"
							render={<Link href={`/dashboard/servers/${server.id}`} />}
						>
							<ItemMedia variant="icon">
								<ServerIcon className="size-5 text-muted-foreground" />
							</ItemMedia>
							<ItemContent>
								<div className="flex items-center justify-between">
									<ItemTitle>{server.name}</ItemTitle>
									<StatusIndicator status={server.status} />
								</div>
								<ItemDescription>
									{server.wireguardIp || "Not registered"}
								</ItemDescription>
							</ItemContent>
						</Item>
					))}
				</ItemGroup>
			)}
		</div>
	);
}
