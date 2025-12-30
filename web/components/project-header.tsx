"use client";

import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { EditableText } from "@/components/editable-text";
import { updateProject } from "@/actions/projects";

export function ProjectHeader({
	projectId,
	projectName,
	actions,
}: {
	projectId: string;
	projectName: string;
	actions?: React.ReactNode;
}) {
	const router = useRouter();

	const handleNameChange = async (newName: string) => {
		const result = await updateProject(projectId, newName);
		router.replace(`/dashboard/projects/${result.slug}`);
	};

	return (
		<PageHeader
			title={
				<EditableText
					value={projectName}
					onChange={handleNameChange}
					label="project name"
					textClassName="text-base font-bold"
				/>
			}
			breadcrumbs={[{ label: "Projects", href: "/dashboard" }]}
			actions={actions}
		/>
	);
}
