"use client";

import { useMemo } from "react";
import { useService } from "@/components/service-layout-client";
import { LogViewer } from "@/components/log-viewer";

export default function LogsPage() {
	const { service } = useService();

	const servers = useMemo(() => {
		const deployments = service.deployments || [];
		const serverMap = new Map<string, string>();
		for (const d of deployments) {
			if (d.server) {
				serverMap.set(d.serverId, d.server.name);
			}
		}
		return Array.from(serverMap.entries()).map(([id, name]) => ({ id, name }));
	}, [service.deployments]);

	return (
		<LogViewer
			variant="service-logs"
			serviceId={service.id}
			servers={servers}
		/>
	);
}
