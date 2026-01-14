"use server";

import { setSetting } from "@/db/queries";
import { revalidatePath } from "next/cache";
import {
	SETTING_KEYS,
	MIN_BACKUP_RETENTION_DAYS,
	MAX_BACKUP_RETENTION_DAYS,
	type BackupStorageConfig,
} from "@/lib/settings-keys";

export async function updateBuildServers(serverIds: string[]) {
	await setSetting(SETTING_KEYS.SERVERS_ALLOWED_FOR_BUILDS, serverIds);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateExcludedServers(serverIds: string[]) {
	await setSetting(
		SETTING_KEYS.SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT,
		serverIds,
	);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateBuildTimeout(minutes: number) {
	if (minutes < 5 || minutes > 120) {
		throw new Error("Build timeout must be between 5 and 120 minutes");
	}
	await setSetting(SETTING_KEYS.BUILD_TIMEOUT_MINUTES, minutes);
	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateBackupStorageConfig(config: BackupStorageConfig) {
	if (
		config.retentionDays < MIN_BACKUP_RETENTION_DAYS ||
		config.retentionDays > MAX_BACKUP_RETENTION_DAYS
	) {
		throw new Error(
			`Retention days must be between ${MIN_BACKUP_RETENTION_DAYS} and ${MAX_BACKUP_RETENTION_DAYS}`,
		);
	}

	await setSetting(SETTING_KEYS.BACKUP_STORAGE_CONFIG, config);

	revalidatePath("/dashboard/settings");
	return { success: true };
}
