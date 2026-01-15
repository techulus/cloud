"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	Hammer,
	Server,
	Rocket,
	Ban,
	Clock,
	HardDrive,
	Github,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
	updateBackupStorageConfig,
} from "@/actions/settings";
import type { Server as ServerType } from "@/db/types";
import {
	MIN_BACKUP_RETENTION_DAYS,
	MAX_BACKUP_RETENTION_DAYS,
	DEFAULT_BACKUP_RETENTION_DAYS,
	type BackupStorageProvider,
} from "@/lib/settings-keys";
import { GitHubAppSetup } from "@/components/github-app-setup";

type Props = {
	servers: ServerType[];
	initialSettings: {
		buildServerIds: string[];
		excludedServerIds: string[];
		buildTimeoutMinutes: number;
		backupStorage: {
			provider: string;
			bucket: string;
			region: string;
			endpoint: string;
			accessKey: string;
			secretKey: string;
			retentionDays: number;
		} | null;
	};
	initialTab?: string;
};

export function GlobalSettings({
	servers,
	initialSettings,
	initialTab = "build",
}: Props) {
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

	const [backupProvider, setBackupProvider] = useState(
		initialSettings.backupStorage?.provider ?? "",
	);
	const [backupBucket, setBackupBucket] = useState(
		initialSettings.backupStorage?.bucket ?? "",
	);
	const [backupRegion, setBackupRegion] = useState(
		initialSettings.backupStorage?.region ?? "",
	);
	const [backupEndpoint, setBackupEndpoint] = useState(
		initialSettings.backupStorage?.endpoint ?? "",
	);
	const [backupAccessKey, setBackupAccessKey] = useState(
		initialSettings.backupStorage?.accessKey ?? "",
	);
	const [backupSecretKey, setBackupSecretKey] = useState(
		initialSettings.backupStorage?.secretKey ?? "",
	);
	const [backupRetentionDays, setBackupRetentionDays] = useState(
		initialSettings.backupStorage?.retentionDays ??
			DEFAULT_BACKUP_RETENTION_DAYS,
	);
	const [isSavingBackup, setIsSavingBackup] = useState(false);

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

	const handleSaveBackupStorage = async () => {
		if (
			!backupProvider ||
			!backupBucket ||
			!backupAccessKey ||
			!backupSecretKey
		) {
			toast.error("Please fill in all required fields");
			return;
		}
		setIsSavingBackup(true);
		try {
			await updateBackupStorageConfig({
				provider: backupProvider as BackupStorageProvider,
				bucket: backupBucket,
				region: backupRegion,
				endpoint: backupEndpoint,
				accessKey: backupAccessKey,
				secretKey: backupSecretKey,
				retentionDays: backupRetentionDays,
			});
			toast.success("Backup volume settings updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingBackup(false);
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

	const backupStorageChanged =
		backupProvider !== (initialSettings.backupStorage?.provider ?? "") ||
		backupBucket !== (initialSettings.backupStorage?.bucket ?? "") ||
		backupRegion !== (initialSettings.backupStorage?.region ?? "") ||
		backupEndpoint !== (initialSettings.backupStorage?.endpoint ?? "") ||
		backupAccessKey !== (initialSettings.backupStorage?.accessKey ?? "") ||
		backupSecretKey !== (initialSettings.backupStorage?.secretKey ?? "") ||
		backupRetentionDays !==
			(initialSettings.backupStorage?.retentionDays ??
				DEFAULT_BACKUP_RETENTION_DAYS);

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
		<Tabs defaultValue={initialTab}>
			<TabsList>
				<TabsTrigger value="build" className="px-4 py-2">
					<Hammer className="size-4" />
					Build
				</TabsTrigger>
				<TabsTrigger value="deployment" className="px-4 py-2">
					<Rocket className="size-4" />
					Deployment
				</TabsTrigger>
				<TabsTrigger value="backup" className="px-4 py-2">
					<HardDrive className="size-4" />
					Backup
				</TabsTrigger>
				<TabsTrigger value="github" className="px-4 py-2">
					<Github className="size-4" />
					GitHub
				</TabsTrigger>
			</TabsList>

			<TabsContent value="build" className="space-y-6 pt-4">
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
						<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
			</TabsContent>

			<TabsContent value="deployment" className="space-y-6 pt-4">
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
						<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
			</TabsContent>

			<TabsContent value="backup" className="space-y-6 pt-4">
				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<HardDrive className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Backup Storage</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<p className="text-sm text-muted-foreground">
							Configure S3-compatible storage for volume backups. This is
							required for backing up stateful services and migrating them
							between servers.
						</p>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div className="space-y-2">
								<Label htmlFor="backup-provider">Provider</Label>
								<NativeSelect
									id="backup-provider"
									value={backupProvider}
									onChange={(e) => setBackupProvider(e.target.value)}
								>
									<NativeSelectOption value="">
										Select provider
									</NativeSelectOption>
									<NativeSelectOption value="s3">AWS S3</NativeSelectOption>
									<NativeSelectOption value="r2">
										Cloudflare R2
									</NativeSelectOption>
									<NativeSelectOption value="gcs">
										Google Cloud Storage
									</NativeSelectOption>
									<NativeSelectOption value="custom">
										Custom S3-Compatible
									</NativeSelectOption>
								</NativeSelect>
							</div>

							<div className="space-y-2">
								<Label htmlFor="backup-bucket">Bucket Name</Label>
								<Input
									id="backup-bucket"
									value={backupBucket}
									onChange={(e) => setBackupBucket(e.target.value)}
									placeholder="my-backup-bucket"
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="backup-region">
									Region{" "}
									<span className="text-muted-foreground">(optional)</span>
								</Label>
								<Input
									id="backup-region"
									value={backupRegion}
									onChange={(e) => setBackupRegion(e.target.value)}
									placeholder="us-east-1"
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="backup-endpoint">
									Endpoint{" "}
									<span className="text-muted-foreground">(for R2/custom)</span>
								</Label>
								<Input
									id="backup-endpoint"
									value={backupEndpoint}
									onChange={(e) => setBackupEndpoint(e.target.value)}
									placeholder="https://..."
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="backup-access-key">Access Key</Label>
								<Input
									id="backup-access-key"
									value={backupAccessKey}
									onChange={(e) => setBackupAccessKey(e.target.value)}
									placeholder="AKIA..."
								/>
							</div>

							<div className="space-y-2">
								<Label htmlFor="backup-secret-key">Secret Key</Label>
								<Input
									id="backup-secret-key"
									type="password"
									value={backupSecretKey}
									onChange={(e) => setBackupSecretKey(e.target.value)}
									placeholder="••••••••"
								/>
							</div>
						</div>

						<div className="space-y-2 pt-2">
							<Label htmlFor="backup-retention">Retention Period</Label>
							<div className="flex items-center gap-3">
								<Input
									id="backup-retention"
									type="number"
									min={MIN_BACKUP_RETENTION_DAYS}
									max={MAX_BACKUP_RETENTION_DAYS}
									value={backupRetentionDays}
									onChange={(e) =>
										setBackupRetentionDays(
											parseInt(e.target.value, 10) || MIN_BACKUP_RETENTION_DAYS,
										)
									}
									className="w-24"
								/>
								<span className="text-sm text-muted-foreground">days</span>
							</div>
							<p className="text-xs text-muted-foreground">
								Backups older than this will be automatically deleted. Range:{" "}
								{MIN_BACKUP_RETENTION_DAYS}-{MAX_BACKUP_RETENTION_DAYS} days.
							</p>
						</div>

						{backupStorageChanged && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSaveBackupStorage}
									disabled={isSavingBackup}
									size="sm"
								>
									{isSavingBackup ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>
				</div>
			</TabsContent>

			<TabsContent value="github" className="space-y-6 pt-4">
				<GitHubAppSetup />
			</TabsContent>
		</Tabs>
	);
}
