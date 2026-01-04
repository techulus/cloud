"use client";

import { useService } from "@/components/service-layout-client";
import { BuildsViewer } from "@/components/service-details/builds-viewer";

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
