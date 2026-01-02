"use client";

import { useService } from "@/components/service-layout-client";
import { LogsViewer } from "@/components/service-details/logs-viewer";

export default function LogsPage() {
	const { service } = useService();

	return <LogsViewer serviceId={service.id} />;
}
