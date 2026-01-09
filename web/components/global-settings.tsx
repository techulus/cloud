"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Hammer, Server, Ban, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	updateBuildServers,
	updateExcludedServers,
	updateBuildTimeout,
} from "@/actions/settings";
import type { Server as ServerType } from "@/db/types";

type Props = {
	servers: ServerType[];
	initialSettings: {
		buildServerIds: string[];
		excludedServerIds: string[];
		buildTimeoutMinutes: number;
	};
};

export function GlobalSettings({ servers, initialSettings }: Props) {
	const router = useRouter();
	const [buildServerIds, setBuildServerIds] = useState<Set<string>>(
		new Set(initialSettings.buildServerIds),
	);
	const [excludedServerIds, setExcludedServerIds] = useState<Set<string>>(
		new Set(initialSettings.excludedServerIds),
	);
	const [buildTimeoutMinutes, setBuildTimeoutMinutes] = useState(
		String(initialSettings.buildTimeoutMinutes),
	);
	const [isSavingBuild, setIsSavingBuild] = useState(false);
	const [isSavingExcluded, setIsSavingExcluded] = useState(false);
	const [isSavingTimeout, setIsSavingTimeout] = useState(false);

	const toggleBuildServer = (serverId: string) => {
		setBuildServerIds((prev) => {
			const next = new Set(prev);
			if (next.has(serverId)) {
				next.delete(serverId);
			} else {
				next.add(serverId);
			}
			return next;
		});
	};

	const toggleExcludedServer = (serverId: string) => {
		setExcludedServerIds((prev) => {
			const next = new Set(prev);
			if (next.has(serverId)) {
				next.delete(serverId);
			} else {
				next.add(serverId);
			}
			return next;
		});
	};

	const handleSaveBuildServers = async () => {
		setIsSavingBuild(true);
		try {
			await updateBuildServers(Array.from(buildServerIds));
			toast.success("Build servers updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingBuild(false);
		}
	};

	const handleSaveExcludedServers = async () => {
		setIsSavingExcluded(true);
		try {
			await updateExcludedServers(Array.from(excludedServerIds));
			toast.success("Excluded servers updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingExcluded(false);
		}
	};

	const handleSaveBuildTimeout = async () => {
		setIsSavingTimeout(true);
		try {
			await updateBuildTimeout(parseInt(buildTimeoutMinutes, 10));
			toast.success("Build timeout updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingTimeout(false);
		}
	};

	const buildServersChanged =
		buildServerIds.size !== initialSettings.buildServerIds.length ||
		!initialSettings.buildServerIds.every((id) => buildServerIds.has(id));

	const excludedServersChanged =
		excludedServerIds.size !== initialSettings.excludedServerIds.length ||
		!initialSettings.excludedServerIds.every((id) => excludedServerIds.has(id));

	const buildTimeoutChanged =
		buildTimeoutMinutes !== String(initialSettings.buildTimeoutMinutes);

	if (servers.length === 0) {
		return (
			<Empty className="border py-10">
				<EmptyMedia variant="icon">
					<Server />
				</EmptyMedia>
				<EmptyTitle>No servers</EmptyTitle>
				<EmptyDescription>
					Add servers to configure global settings.
				</EmptyDescription>
			</Empty>
		);
	}

	return (
		<div className="space-y-6">
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Hammer className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Build Servers</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Select which servers can run builds. If none are selected, all
						online servers can run builds.
					</p>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						{servers.map((server) => (
							<button
								type="button"
								key={server.id}
								onClick={() => toggleBuildServer(server.id)}
								className={`flex items-center gap-4 p-3 rounded-md text-left transition-colors ${
									buildServerIds.has(server.id)
										? "bg-primary text-primary-foreground"
										: "bg-muted hover:bg-muted/80"
								}`}
							>
								<div className="flex-1 min-w-0">
									<p className="font-medium truncate">{server.name}</p>
									<p
										className={`text-xs font-mono ${
											buildServerIds.has(server.id)
												? "text-primary-foreground/70"
												: "text-muted-foreground"
										}`}
									>
										{server.wireguardIp || server.publicIp || "No IP"}
									</p>
								</div>
							</button>
						))}
					</div>
					<div className="flex items-center justify-between text-sm">
						<span>
							{buildServerIds.size === 0
								? "All servers can build"
								: `${buildServerIds.size} server${buildServerIds.size !== 1 ? "s" : ""} selected`}
						</span>
					</div>
					{buildServersChanged && (
						<div className="pt-3 border-t">
							<Button
								onClick={handleSaveBuildServers}
								disabled={isSavingBuild}
								size="sm"
							>
								{isSavingBuild ? "Saving..." : "Save"}
							</Button>
						</div>
					)}
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Ban className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Excluded from Workloads</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Select servers to exclude from workload placement. These servers
						will not receive any new deployments.
					</p>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						{servers.map((server) => (
							<button
								type="button"
								key={server.id}
								onClick={() => toggleExcludedServer(server.id)}
								className={`flex items-center gap-4 p-3 rounded-md text-left transition-colors ${
									excludedServerIds.has(server.id)
										? "bg-destructive text-destructive-foreground"
										: "bg-muted hover:bg-muted/80"
								}`}
							>
								<div className="flex-1 min-w-0">
									<p className="font-medium truncate">{server.name}</p>
									<p
										className={`text-xs font-mono ${
											excludedServerIds.has(server.id)
												? "text-destructive-foreground/70"
												: "text-muted-foreground"
										}`}
									>
										{server.wireguardIp || server.publicIp || "No IP"}
									</p>
								</div>
							</button>
						))}
					</div>
					<div className="flex items-center justify-between text-sm">
						<span>
							{excludedServerIds.size === 0
								? "No servers excluded"
								: `${excludedServerIds.size} server${excludedServerIds.size !== 1 ? "s" : ""} excluded`}
						</span>
					</div>
					{excludedServersChanged && (
						<div className="pt-3 border-t">
							<Button
								onClick={handleSaveExcludedServers}
								disabled={isSavingExcluded}
								size="sm"
							>
								{isSavingExcluded ? "Saving..." : "Save"}
							</Button>
						</div>
					)}
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Clock className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Build Timeout</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Maximum time allowed for builds to complete. Builds exceeding this
						limit will be automatically cancelled.
					</p>
					<div className="flex items-center gap-3">
						<Input
							type="number"
							min={5}
							max={120}
							value={buildTimeoutMinutes}
							onChange={(e) => setBuildTimeoutMinutes(e.target.value)}
							className="w-24"
						/>
						<span className="text-sm text-muted-foreground">minutes</span>
					</div>
					<p className="text-xs text-muted-foreground">
						Minimum: 5 minutes, Maximum: 120 minutes
					</p>
					{buildTimeoutChanged && (
						<div className="pt-3 border-t">
							<Button
								onClick={handleSaveBuildTimeout}
								disabled={isSavingTimeout}
								size="sm"
							>
								{isSavingTimeout ? "Saving..." : "Save"}
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
