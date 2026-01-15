"use client";

import { useService } from "@/components/service/service-layout-client";
import { BuildsViewer } from "@/components/builds/builds-viewer";

export default function BuildsPage() {
	const { service, projectSlug, envName } = useService();

	return (
		<BuildsViewer
			serviceId={service.id}
			projectSlug={projectSlug}
			envName={envName}
		/>
	);
}
