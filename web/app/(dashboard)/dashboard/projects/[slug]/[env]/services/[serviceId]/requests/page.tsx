"use client";

import { useService } from "@/components/service-layout-client";
import { LogViewer } from "@/components/log-viewer";

export default function RequestsPage() {
	const { service } = useService();

	return <LogViewer variant="requests" serviceId={service.id} />;
}
