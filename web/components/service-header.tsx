"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { EditableText } from "@/components/editable-text";
import { useBreadcrumbs } from "@/components/breadcrumb-context";
import { updateServiceName } from "@/actions/projects";

type Breadcrumb = {
	label: string;
	href?: string;
};

export function ServiceHeader({
	serviceId,
	serviceName,
	breadcrumbs,
}: {
	serviceId: string;
	serviceName: string;
	breadcrumbs: Breadcrumb[];
}) {
	const router = useRouter();
	const { setBreadcrumbs, clearBreadcrumbs } = useBreadcrumbs();

	const handleNameChange = async (newName: string) => {
		await updateServiceName(serviceId, newName);
		router.refresh();
	};

	useEffect(() => {
		setBreadcrumbs(
			breadcrumbs,
			<EditableText
				value={serviceName}
				onChange={handleNameChange}
				label="service name"
				textClassName="text-sm font-semibold"
			/>
		);
		return () => clearBreadcrumbs();
	}, [breadcrumbs, serviceName]);

	return null;
}
