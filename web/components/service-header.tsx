"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { EditableText } from "@/components/editable-text";
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

	const handleNameChange = async (newName: string) => {
		await updateServiceName(serviceId, newName);
		router.refresh();
	};

	return (
		<PageHeader
			title={
				<EditableText
					value={serviceName}
					onChange={handleNameChange}
					label="service name"
					textClassName="text-base font-bold"
				/>
			}
			breadcrumbs={breadcrumbs}
		/>
	);
}
