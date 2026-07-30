"use client";

import { Cpu, Server as ServerIcon } from "lucide-react";
import Link from "next/link";
import useSWR from "swr";
import { StatusIndicator } from "@/components/core/status-indicator";
import {
	SUMMARY_CARD_CLASSNAME,
	SUMMARY_CARD_COMPACT_CLASSNAME,
	SUMMARY_CARD_COMPACT_TEXT_CLASSNAME,
	SUMMARY_CARD_COMPACT_TITLE_CLASSNAME,
	SUMMARY_CARD_GRID_CLASSNAME,
	SummaryCardLine,
	SummaryCardStat,
	SummaryCardTitle,
	SummaryCardValue,
} from "@/components/core/summary-card";
import { CreateServerDialog } from "@/components/server/create-server-dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import type { Server } from "@/db/types";
import { fetcher } from "@/lib/fetcher";
import { cn } from "@/lib/utils";

type ServerWithResources = Pick<
	Server,
	| "id"
	| "name"
	| "status"
	| "isProxy"
	| "resourcesCpu"
	| "resourcesMemory"
	| "resourcesDisk"
	| "meta"
>;

function formatResources(server: ServerWithResources): string | null {
	const parts: string[] = [];

	if (server.resourcesCpu !== null) {
		parts.push(`${server.resourcesCpu} cores`);
	}
	if (server.resourcesMemory !== null) {
		parts.push(`${Math.round((server.resourcesMemory / 1024) * 10) / 10} GB`);
	}
	if (server.resourcesDisk !== null) {
		parts.push(`${server.resourcesDisk} GB`);
	}

	return parts.length > 0 ? parts.join(" · ") : null;
}

function formatOsArch(server: ServerWithResources): string | null {
	if (server.meta?.os && server.meta?.arch) {
		return `${server.meta.os}/${server.meta.arch}`;
	}
	return null;
}

export function ServerList({
	initialServers,
	showHeader = true,
}: {
	initialServers: ServerWithResources[];
	showHeader?: boolean;
}) {
	const { data: servers } = useSWR<ServerWithResources[]>(
		"/api/servers",
		fetcher,
		{
			fallbackData: initialServers,
			refreshInterval: 10000,
			revalidateOnFocus: true,
		},
	);

	return (
		<div className={showHeader ? "space-y-6" : undefined}>
			{showHeader && (
				<div className="flex items-center justify-between">
					<div>
						<h2 className="text-lg font-semibold">Servers</h2>
						<p className="text-sm text-muted-foreground">
							Manage your server fleet
						</p>
					</div>
					<CreateServerDialog />
				</div>
			)}

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
				<div className={SUMMARY_CARD_GRID_CLASSNAME}>
					{servers.map((server) => (
						<Link
							key={server.id}
							href={`/dashboard/servers/${server.id}`}
							className={cn(
								SUMMARY_CARD_CLASSNAME,
								SUMMARY_CARD_COMPACT_CLASSNAME,
							)}
						>
							<div className="flex items-center justify-between gap-2">
								<SummaryCardTitle
									className={cn(
										"min-w-0",
										SUMMARY_CARD_COMPACT_TITLE_CLASSNAME,
									)}
								>
									{server.name}
								</SummaryCardTitle>
								{server.isProxy && (
									<span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">
										proxy
									</span>
								)}
							</div>
							<div className="hidden sm:mt-1.5 sm:block">
								<SummaryCardLine
									icon={Cpu}
									value={formatResources(server) || "not registered"}
								/>
							</div>
							<div className="mt-auto pt-2 sm:pt-3">
								<SummaryCardStat
									label="platform"
									className={cn(
										"hidden sm:flex",
										SUMMARY_CARD_COMPACT_TEXT_CLASSNAME,
									)}
								>
									<SummaryCardValue
										className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
									>
										{formatOsArch(server) || "—"}
									</SummaryCardValue>
								</SummaryCardStat>
								<SummaryCardStat
									label="status"
									className={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
								>
									<StatusIndicator
										status={server.status}
										showLabel
										labelClassName={SUMMARY_CARD_COMPACT_TEXT_CLASSNAME}
									/>
								</SummaryCardStat>
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
