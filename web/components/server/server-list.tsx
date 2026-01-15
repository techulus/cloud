"use client";

import { Globe, Server as ServerIcon } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { StatusIndicator } from "@/components/core/status-indicator";
import { CreateServerDialog } from "@/components/server/create-server-dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
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
	"id" | "name" | "publicIp" | "wireguardIp" | "status" | "isProxy"
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
				<Empty className="border py-10">
					<EmptyMedia variant="icon">
						<ServerIcon />
					</EmptyMedia>
					<EmptyTitle>No servers yet</EmptyTitle>
					<EmptyDescription>
						Add your first server to get started.
					</EmptyDescription>
					<EmptyContent>
						<CreateServerDialog />
					</EmptyContent>
				</Empty>
			) : (
				<ItemGroup className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{servers.map((server) => (
						<Item
							key={server.id}
							variant="outline"
							render={<Link href={`/dashboard/servers/${server.id}`} />}
						>
							<ItemMedia variant="icon">
								{server.isProxy ? (
									<Globe className="size-5 text-muted-foreground" />
								) : (
									<ServerIcon className="size-5 text-muted-foreground" />
								)}
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
