"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { EditableText } from "@/components/editable-text";
import { useBreadcrumbs } from "@/components/breadcrumb-context";
import { updateProject } from "@/actions/projects";

export function ProjectHeader({
	projectId,
	projectName,
}: {
	projectId: string;
	projectName: string;
}) {
	const router = useRouter();
	const { setBreadcrumbs, clearBreadcrumbs } = useBreadcrumbs();

	const handleNameChange = async (newName: string) => {
		const result = await updateProject(projectId, newName);
		router.replace(`/dashboard/projects/${result.slug}`);
	};

	useEffect(() => {
		setBreadcrumbs(
			[{ label: "Projects", href: "/dashboard" }],
			<EditableText
				value={projectName}
				onChange={handleNameChange}
				label="project name"
				textClassName="text-sm font-semibold"
			/>
		);
		return () => clearBreadcrumbs();
	}, [projectName]);

	return null;
}
