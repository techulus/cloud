"use client";

import { useService } from "@/components/service-layout-client";
import { BackupTab } from "@/components/service-details/backup-tab";

export default function BackupsPage() {
	const { service, onUpdate } = useService();

	return <BackupTab service={service} onUpdate={onUpdate} />;
}
