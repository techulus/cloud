"use client";

import useSWR from "swr";
import Link from "next/link";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

import { CreateServerDialog } from "@/components/create-server-dialog";
import { PageHeader } from "@/components/page-header";
import { fetcher } from "@/lib/fetcher";

type Server = {
	id: string;
	name: string;
	publicIp: string | null;
	wireguardIp: string | null;
	status: string;
};

function StatusIndicator({ status }: { status: string }) {
	const colors: Record<string, { dot: string; text: string }> = {
		online: {
			dot: "bg-emerald-500",
			text: "text-emerald-600 dark:text-emerald-400",
		},
		pending: {
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		},
		offline: {
			dot: "bg-rose-500",
			text: "text-rose-600 dark:text-rose-400",
		},
		unknown: {
			dot: "bg-zinc-400",
			text: "text-zinc-500",
		},
	};

	const color = colors[status] || colors.unknown;

	return (
		<div className="flex items-center gap-1.5">
			<span className="relative flex h-2 w-2">
				{status === "online" && (
					<span
						className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color.dot} opacity-75`}
					/>
				)}
				<span
					className={`relative inline-flex rounded-full h-2 w-2 ${color.dot}`}
				/>
			</span>
			<span className={`text-xs font-medium capitalize ${color.text}`}>
				{status}
			</span>
		</div>
	);
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
				actions={<CreateServerDialog />}
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
