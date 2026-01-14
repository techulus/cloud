"use client";

import { useState, useEffect, memo } from "react";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Archive,
	Download,
	Trash2,
	RefreshCcw,
	Clock,
	CheckCircle,
	XCircle,
	Loader2,
} from "lucide-react";
import {
	createBackup,
	listBackups,
	restoreBackup,
	deleteBackup,
} from "@/actions/backups";
import { updateServiceBackupSettings } from "@/actions/projects";
import type { ServiceWithDetails as Service } from "@/db/types";

type BackupItem = {
	id: string;
	volumeName: string;
	status: string;
	sizeBytes: number | null;
	createdAt: Date;
	completedAt: Date | null;
	errorMessage: string | null;
	serverName: string | null;
};

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

function formatDate(date: Date): string {
	return new Date(date).toLocaleString();
}

function getStatusIcon(status: string) {
	switch (status) {
		case "completed":
			return <CheckCircle className="h-4 w-4 text-green-500" />;
		case "failed":
			return <XCircle className="h-4 w-4 text-red-500" />;
		case "pending":
		case "uploading":
			return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
		default:
			return <Clock className="h-4 w-4 text-muted-foreground" />;
	}
}

export const BackupTab = memo(function BackupTab({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [backups, setBackups] = useState<BackupItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [creatingBackup, setCreatingBackup] = useState(false);
	const [restoringId, setRestoringId] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [backupEnabled, setBackupEnabled] = useState(
		service.backupEnabled ?? false,
	);
	const [backupSchedule, setBackupSchedule] = useState(
		service.backupSchedule ?? "",
	);
	const [savingSettings, setSavingSettings] = useState(false);

	const volumes = service.volumes || [];

	const loadBackups = async () => {
		setLoading(true);
		try {
			const result = await listBackups(service.id);
			setBackups(result as BackupItem[]);
		} catch {
			setError("Failed to load backups");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadBackups();
	}, [service.id]);

	const handleCreateBackup = async (volumeId: string) => {
		setCreatingBackup(true);
		setError(null);
		try {
			await createBackup(service.id, volumeId);
			await loadBackups();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to create backup");
		} finally {
			setCreatingBackup(false);
		}
	};

	const handleRestore = async (backupId: string) => {
		if (
			!confirm(
				"Are you sure you want to restore this backup? This will replace current volume data.",
			)
		) {
			return;
		}
		setRestoringId(backupId);
		setError(null);
		try {
			await restoreBackup(service.id, backupId);
			onUpdate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to restore backup");
		} finally {
			setRestoringId(null);
		}
	};

	const handleDelete = async (backupId: string) => {
		if (!confirm("Are you sure you want to delete this backup?")) {
			return;
		}
		setDeletingId(backupId);
		setError(null);
		try {
			await deleteBackup(backupId);
			await loadBackups();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to delete backup");
		} finally {
			setDeletingId(null);
		}
	};

	const handleSaveSettings = async () => {
		setSavingSettings(true);
		setError(null);
		try {
			await updateServiceBackupSettings(
				service.id,
				backupEnabled,
				backupSchedule || null,
			);
			onUpdate();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save settings");
		} finally {
			setSavingSettings(false);
		}
	};

	if (!service.stateful) {
		return (
			<div className="rounded-lg border p-4">
				<p className="text-sm text-muted-foreground">
					Backups are only available for stateful services.
				</p>
			</div>
		);
	}

	if (volumes.length === 0) {
		return (
			<div className="rounded-lg border p-4">
				<p className="text-sm text-muted-foreground">
					No volumes configured. Add volumes to enable backups.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Clock className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Scheduled Backups</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<div className="flex items-center gap-4">
						<label className="flex items-center gap-2">
							<input
								type="checkbox"
								checked={backupEnabled}
								onChange={(e) => setBackupEnabled(e.target.checked)}
								className="rounded"
							/>
							<span className="text-sm">Enable scheduled backups</span>
						</label>
					</div>

					{backupEnabled && (
						<div className="flex items-center gap-4">
							<Select
								value={backupSchedule}
								onValueChange={(v) => v && setBackupSchedule(v)}
							>
								<SelectTrigger className="w-40">
									<SelectValue>
										{backupSchedule || "Select schedule"}
									</SelectValue>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="daily">Daily</SelectItem>
									<SelectItem value="weekly">Weekly</SelectItem>
								</SelectContent>
							</Select>
						</div>
					)}

					<Button
						size="sm"
						onClick={handleSaveSettings}
						disabled={savingSettings}
					>
						{savingSettings ? "Saving..." : "Save Settings"}
					</Button>
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Archive className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Manual Backup</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Create a backup of any volume immediately.
					</p>
					<div className="flex flex-wrap gap-2">
						{volumes.map((volume) => (
							<Button
								key={volume.id}
								size="sm"
								variant="outline"
								onClick={() => handleCreateBackup(volume.id)}
								disabled={creatingBackup}
							>
								{creatingBackup ? (
									<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								) : (
									<Archive className="h-4 w-4 mr-2" />
								)}
								Backup {volume.name}
							</Button>
						))}
					</div>
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Download className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Backups</ItemTitle>
					</ItemContent>
					<Button
						variant="ghost"
						size="icon"
						onClick={loadBackups}
						disabled={loading}
					>
						<RefreshCcw
							className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
						/>
					</Button>
				</Item>
				<div className="p-4 space-y-2">
					{error && (
						<p className="text-sm text-red-600 dark:text-red-400 mb-2">
							{error}
						</p>
					)}

					{loading ? (
						<p className="text-sm text-muted-foreground">Loading backups...</p>
					) : backups.length === 0 ? (
						<p className="text-sm text-muted-foreground">No backups found.</p>
					) : (
						backups.map((backup) => (
							<div
								key={backup.id}
								className="flex items-center justify-between p-3 bg-muted rounded-md"
							>
								<div className="flex items-center gap-3">
									{getStatusIcon(backup.status)}
									<div>
										<p className="font-medium text-sm">{backup.volumeName}</p>
										<p className="text-xs text-muted-foreground">
											{formatDate(backup.createdAt)}
											{backup.sizeBytes &&
												` · ${formatBytes(backup.sizeBytes)}`}
											{backup.serverName && ` · ${backup.serverName}`}
										</p>
										{backup.errorMessage && (
											<p className="text-xs text-red-500">
												{backup.errorMessage}
											</p>
										)}
									</div>
								</div>
								<div className="flex items-center gap-1">
									{backup.status === "completed" && (
										<Button
											variant="ghost"
											size="icon"
											onClick={() => handleRestore(backup.id)}
											disabled={restoringId === backup.id}
											title="Restore this backup"
										>
											{restoringId === backup.id ? (
												<Loader2 className="h-4 w-4 animate-spin" />
											) : (
												<Download className="h-4 w-4" />
											)}
										</Button>
									)}
									<Button
										variant="ghost"
										size="icon"
										onClick={() => handleDelete(backup.id)}
										disabled={deletingId === backup.id}
										title="Delete backup"
									>
										{deletingId === backup.id ? (
											<Loader2 className="h-4 w-4 animate-spin" />
										) : (
											<Trash2 className="h-4 w-4" />
										)}
									</Button>
								</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
});
