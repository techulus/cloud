"use client";

import { useEffect, memo, useReducer, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
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
import { detectDatabaseType } from "@/lib/database-utils";
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

type BackupState = {
	backups: BackupItem[];
	loading: boolean;
	error: string | null;
	creatingBackup: boolean;
	restoringId: string | null;
	deletingId: string | null;
	confirmRestoreId: string | null;
	confirmDeleteId: string | null;
	backupEnabled: boolean;
	backupSchedule: string;
	savingSettings: boolean;
};

type BackupAction =
	| { type: "SET_BACKUPS"; payload: BackupItem[] }
	| { type: "SET_LOADING"; payload: boolean }
	| { type: "SET_ERROR"; payload: string | null }
	| { type: "SET_CREATING_BACKUP"; payload: boolean }
	| { type: "SET_RESTORING_ID"; payload: string | null }
	| { type: "SET_DELETING_ID"; payload: string | null }
	| { type: "SET_CONFIRM_RESTORE_ID"; payload: string | null }
	| { type: "SET_CONFIRM_DELETE_ID"; payload: string | null }
	| { type: "SET_BACKUP_ENABLED"; payload: boolean }
	| { type: "SET_BACKUP_SCHEDULE"; payload: string }
	| { type: "SET_SAVING_SETTINGS"; payload: boolean };

function backupReducer(state: BackupState, action: BackupAction): BackupState {
	switch (action.type) {
		case "SET_BACKUPS":
			return { ...state, backups: action.payload };
		case "SET_LOADING":
			return { ...state, loading: action.payload };
		case "SET_ERROR":
			return { ...state, error: action.payload };
		case "SET_CREATING_BACKUP":
			return { ...state, creatingBackup: action.payload };
		case "SET_RESTORING_ID":
			return { ...state, restoringId: action.payload };
		case "SET_DELETING_ID":
			return { ...state, deletingId: action.payload };
		case "SET_CONFIRM_RESTORE_ID":
			return { ...state, confirmRestoreId: action.payload };
		case "SET_CONFIRM_DELETE_ID":
			return { ...state, confirmDeleteId: action.payload };
		case "SET_BACKUP_ENABLED":
			return { ...state, backupEnabled: action.payload };
		case "SET_BACKUP_SCHEDULE":
			return { ...state, backupSchedule: action.payload };
		case "SET_SAVING_SETTINGS":
			return { ...state, savingSettings: action.payload };
	}
}

function createInitialState(service: Service): BackupState {
	return {
		backups: [],
		loading: true,
		error: null,
		creatingBackup: false,
		restoringId: null,
		deletingId: null,
		confirmRestoreId: null,
		confirmDeleteId: null,
		backupEnabled: service.backupEnabled ?? false,
		backupSchedule: service.backupSchedule ?? "",
		savingSettings: false,
	};
}

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
	const [state, dispatch] = useReducer(
		backupReducer,
		service,
		createInitialState,
	);

	const {
		backups,
		loading,
		error,
		creatingBackup,
		restoringId,
		deletingId,
		confirmRestoreId,
		confirmDeleteId,
		backupEnabled,
		backupSchedule,
		savingSettings,
	} = state;

	const volumes = service.volumes || [];
	const detectedDbType = detectDatabaseType(service.image);
	const isDatabaseService = detectedDbType !== null;

	const hasChanges =
		backupEnabled !== (service.backupEnabled ?? false) ||
		backupSchedule !== (service.backupSchedule ?? "");

	const loadBackups = useCallback(async () => {
		dispatch({ type: "SET_LOADING", payload: true });
		try {
			const result = await listBackups(service.id);
			dispatch({ type: "SET_BACKUPS", payload: result as BackupItem[] });
		} catch {
			dispatch({ type: "SET_ERROR", payload: "Failed to load backups" });
		} finally {
			dispatch({ type: "SET_LOADING", payload: false });
		}
	}, [service.id]);

	useEffect(() => {
		loadBackups();
	}, [loadBackups]);

	const handleCreateBackup = useCallback(
		async (volumeId: string) => {
			dispatch({ type: "SET_CREATING_BACKUP", payload: true });
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				await createBackup(service.id, volumeId);
				await loadBackups();
			} catch (e) {
				dispatch({
					type: "SET_ERROR",
					payload: e instanceof Error ? e.message : "Failed to create backup",
				});
			} finally {
				dispatch({ type: "SET_CREATING_BACKUP", payload: false });
			}
		},
		[service.id, loadBackups],
	);

	const handleRestore = useCallback(
		async (backupId: string) => {
			dispatch({ type: "SET_CONFIRM_RESTORE_ID", payload: null });
			dispatch({ type: "SET_RESTORING_ID", payload: backupId });
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				await restoreBackup(service.id, backupId);
				onUpdate();
			} catch (e) {
				dispatch({
					type: "SET_ERROR",
					payload: e instanceof Error ? e.message : "Failed to restore backup",
				});
			} finally {
				dispatch({ type: "SET_RESTORING_ID", payload: null });
			}
		},
		[service.id, onUpdate],
	);

	const handleDelete = useCallback(
		async (backupId: string) => {
			dispatch({ type: "SET_CONFIRM_DELETE_ID", payload: null });
			dispatch({ type: "SET_DELETING_ID", payload: backupId });
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				await deleteBackup(backupId);
				await loadBackups();
			} catch (e) {
				dispatch({
					type: "SET_ERROR",
					payload: e instanceof Error ? e.message : "Failed to delete backup",
				});
			} finally {
				dispatch({ type: "SET_DELETING_ID", payload: null });
			}
		},
		[loadBackups],
	);

	const handleSaveSettings = useCallback(async () => {
		dispatch({ type: "SET_SAVING_SETTINGS", payload: true });
		dispatch({ type: "SET_ERROR", payload: null });
		try {
			await updateServiceBackupSettings(
				service.id,
				backupEnabled,
				backupSchedule || null,
			);
			onUpdate();
		} catch (e) {
			dispatch({
				type: "SET_ERROR",
				payload: e instanceof Error ? e.message : "Failed to save settings",
			});
		} finally {
			dispatch({ type: "SET_SAVING_SETTINGS", payload: false });
		}
	}, [service.id, backupEnabled, backupSchedule, onUpdate]);

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
								onChange={(e) =>
									dispatch({
										type: "SET_BACKUP_ENABLED",
										payload: e.target.checked,
									})
								}
								className="rounded"
							/>
							<span className="text-sm">Enable scheduled backups</span>
						</label>
					</div>

					{backupEnabled && (
						<div className="space-y-4">
							<div className="flex items-center gap-4">
								<NativeSelect
									value={backupSchedule}
									onChange={(e) =>
										dispatch({
											type: "SET_BACKUP_SCHEDULE",
											payload: e.target.value,
										})
									}
								>
									<NativeSelectOption value="">
										Select schedule
									</NativeSelectOption>
									<NativeSelectOption value="daily">Daily</NativeSelectOption>
									<NativeSelectOption value="weekly">Weekly</NativeSelectOption>
								</NativeSelect>
							</div>

							{isDatabaseService && (
								<p className="text-xs text-muted-foreground">
									Database detected ({detectedDbType}). Scheduled backups will use native database tools for portable backups.
								</p>
							)}
						</div>
					)}

					{hasChanges && (
						<Button
							size="sm"
							onClick={handleSaveSettings}
							disabled={savingSettings}
						>
							{savingSettings ? "Saving..." : "Save Settings"}
						</Button>
					)}
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
					<div className="flex items-center gap-2">
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
								Backup
							</Button>
						))}
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
					</div>
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
											variant="outline"
											size="sm"
											onClick={() =>
												dispatch({
													type: "SET_CONFIRM_RESTORE_ID",
													payload: backup.id,
												})
											}
											disabled={restoringId === backup.id}
										>
											{restoringId === backup.id ? (
												<Loader2 className="h-4 w-4 animate-spin" />
											) : (
												"Restore"
											)}
										</Button>
									)}
									<Button
										variant="outline"
										size="icon-sm"
										onClick={() =>
											dispatch({
												type: "SET_CONFIRM_DELETE_ID",
												payload: backup.id,
											})
										}
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

			<AlertDialog
				open={confirmRestoreId !== null}
				onOpenChange={(open) =>
					!open && dispatch({ type: "SET_CONFIRM_RESTORE_ID", payload: null })
				}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Restore Backup</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to restore this backup? This will replace
							current volume data.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								confirmRestoreId && handleRestore(confirmRestoreId)
							}
						>
							Restore
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={confirmDeleteId !== null}
				onOpenChange={(open) =>
					!open && dispatch({ type: "SET_CONFIRM_DELETE_ID", payload: null })
				}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete Backup</AlertDialogTitle>
						<AlertDialogDescription>
							Are you sure you want to delete this backup? This action cannot be
							undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
});
