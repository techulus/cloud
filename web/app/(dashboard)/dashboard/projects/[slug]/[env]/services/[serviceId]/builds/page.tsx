"use client";

import { BuildsViewer } from "@/components/builds/builds-viewer";
import { useService } from "@/components/service/service-layout-client";

export default function BuildsPage() {
	const { service, projectSlug, envName } = useService();

	return (
		<BuildsViewer
			serviceId={service.id}
			hasGithubAppRepo={service.hasGithubAppRepo === true}
			isPreview={Boolean(service.previewOfService)}
			projectSlug={projectSlug}
			envName={envName}
		/>
	);
}
