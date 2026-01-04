"use client";

import { useService } from "@/components/service-layout-client";
import { LogViewer } from "@/components/log-viewer";

export default function LogsPage() {
	const { service } = useService();

	return <LogViewer variant="service-logs" serviceId={service.id} />;
}
