"use server";

import { revalidatePath } from "next/cache";
import { requireDeveloperRole } from "@/lib/auth";
import { deleteBackupInternal } from "@/lib/backups/delete-backup";
import { triggerBackup } from "@/lib/backups/trigger-backup";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";

export async function createBackup(serviceId: string, volumeId: string) {
	await requireDeveloperRole();
	const result = await triggerBackup({
		serviceId,
		volumeId,
	});

	await inngest.send(
		inngestEvents.backupStarted.create({
			backupId: result.backupId,
			serviceId,
			volumeId,
			serverId: result.serverId,
		}),
	);

	revalidatePath(`/dashboard/projects`);
	return { success: true, backupId: result.backupId };
}

export async function restoreBackup(
	serviceId: string,
	backupId: string,
	targetServerId?: string,
) {
	await requireDeveloperRole();
	await inngest.send(
		inngestEvents.restoreTrigger.create({
			serviceId,
			backupId,
			targetServerId,
		}),
	);

	revalidatePath(`/dashboard/projects`);
	return { success: true };
}

export async function deleteBackup(
	backupId: string,
	options: { revalidate?: boolean } = {},
) {
	await requireDeveloperRole();
	const result = await deleteBackupInternal(backupId);
	if (options.revalidate ?? true) {
		revalidatePath(`/dashboard/projects`);
	}
	return result;
}
