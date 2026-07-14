"use client";

import { ChangelogHistory } from "@/components/service/details/changelog-history";
import { useService } from "@/components/service/service-layout-client";

export default function ChangelogPage() {
	const { service, projectSlug, envName } = useService();

	return (
		<ChangelogHistory
			serviceId={service.id}
			projectSlug={projectSlug}
			envName={envName}
		/>
	);
}
