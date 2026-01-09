"use server";

import { setSetting } from "@/db/queries";
import { revalidatePath } from "next/cache";
import { SETTING_KEYS } from "@/lib/settings-keys";

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
