"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	deleteProject,
	updateProjectName,
	updateProjectSlug,
} from "@/actions/projects";
import { DeleteConfirmationDialog } from "@/components/core/delete-confirmation-dialog";
import { EditableText } from "@/components/core/editable-text";
import type { DeleteConfirmation } from "@/lib/two-factor";

type Project = {
	id: string;
	name: string;
	slug: string;
};

export function ProjectSettingsPanel({ project }: { project: Project }) {
	const router = useRouter();

	const handleUpdateName = async (newName: string) => {
		try {
			await updateProjectName(project.id, newName);
			toast.success("Project name updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update name",
			);
			throw error;
		}
	};

	const handleUpdateSlug = async (newSlug: string) => {
		try {
			const result = await updateProjectSlug(project.id, newSlug);
			toast.success("Project slug updated");
			router.push(`/dashboard/projects/${result.slug}/settings`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update slug",
			);
			throw error;
		}
	};

	return (
		<>
			<div className="flex items-center justify-between gap-4 px-3 py-2.5">
				<span className="shrink-0 text-sm text-muted-foreground">Name</span>
				<EditableText
					value={project.name}
					onChange={handleUpdateName}
					label="Project Name"
					textClassName="min-w-0 font-mono text-sm font-medium"
				/>
			</div>
			<div className="space-y-1 px-3 py-2.5">
				<div className="flex items-center justify-between gap-4">
					<span className="shrink-0 text-sm text-muted-foreground">Slug</span>
					<EditableText
						value={project.slug}
						onChange={handleUpdateSlug}
						label="Project Slug"
						textClassName="min-w-0 font-mono text-sm font-medium"
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					The slug is used in the project URL. Changing it will update all
					project links.
				</p>
			</div>
		</>
	);
}

export function ProjectDangerZone({ project }: { project: Project }) {
	const router = useRouter();

	const handleDelete = async (confirmation?: DeleteConfirmation) => {
		await deleteProject(project.id, confirmation);
		toast.success("Project deleted");
		router.push("/dashboard");
	};

	return (
		<div className="rounded-lg border border-destructive/50">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
				<div className="min-w-0">
					<p className="text-sm font-medium">Delete this project</p>
					<p className="text-sm text-muted-foreground">
						Once deleted, this project and all its environments, services, and
						deployments will be permanently removed.
					</p>
				</div>
				<DeleteConfirmationDialog
					resourceName={project.name}
					triggerLabel="Delete Project"
					description="This action cannot be undone. This will permanently delete the project and all its environments, services, and deployments."
					fallbackError="Failed to delete project"
					onDelete={handleDelete}
				/>
			</div>
		</div>
	);
}
