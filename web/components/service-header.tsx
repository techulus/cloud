"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { EditableText } from "@/components/editable-text";
import { updateServiceName, updateServiceHostname } from "@/actions/projects";

type Breadcrumb = {
	label: string;
	href?: string;
};

export function ServiceHeader({
	serviceId,
	serviceName,
	serviceHostname,
	breadcrumbs,
}: {
	serviceId: string;
	serviceName: string;
	serviceHostname: string;
	breadcrumbs: Breadcrumb[];
}) {
	const router = useRouter();

	const handleNameChange = async (newName: string) => {
		await updateServiceName(serviceId, newName);
		router.refresh();
	};

	const handleHostnameChange = async (newHostname: string) => {
		await updateServiceHostname(serviceId, newHostname);
		router.refresh();
	};

	return (
		<PageHeader
			title={
				<div className="flex flex-col gap-1">
					<EditableText
						value={serviceName}
						onChange={handleNameChange}
						label="service name"
						textClassName="text-base font-bold"
					/>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						<span>Private endpoint:</span>
						<EditableText
							value={serviceHostname}
							onChange={handleHostnameChange}
							label="hostname"
							textClassName="text-xs"
						/>
						<span>.internal</span>
					</div>
				</div>
			}
			breadcrumbs={breadcrumbs}
		/>
	);
}
