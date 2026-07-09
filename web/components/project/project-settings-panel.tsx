"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	deleteProject,
	updateProjectName,
	updateProjectSlug,
} from "@/actions/projects";
import { DeleteConfirmationDialog } from "@/components/core/delete-confirmation-dialog";
import { EditableText } from "@/components/core/editable-text";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
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
		<div className="rounded-lg border divide-y">
			<div className="p-4">
				<div className="text-sm text-muted-foreground mb-1">Project Name</div>
				<EditableText
					value={project.name}
					onChange={handleUpdateName}
					label="Project Name"
				/>
			</div>
			<div className="p-4">
				<div className="text-sm text-muted-foreground mb-1">Project Slug</div>
				<EditableText
					value={project.slug}
					onChange={handleUpdateSlug}
					label="Project Slug"
				/>
				<p className="text-sm text-muted-foreground mt-2">
					The slug is used in the project URL. Changing it will update all
					project links.
				</p>
			</div>
		</div>
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
		<div className="space-y-3">
			<h2 className="text-xl font-semibold text-destructive">Danger Zone</h2>
			<div className="rounded-lg border border-destructive/50">
				<Item className="border-0">
					<ItemMedia variant="icon">
						<Trash2 className="size-5 text-destructive" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Delete this project</ItemTitle>
						<p className="text-sm text-muted-foreground">
							Once deleted, this project and all its environments, services, and
							deployments will be permanently removed.
						</p>
					</ItemContent>
					<DeleteConfirmationDialog
						resourceName={project.name}
						triggerLabel="Delete Project"
						description="This action cannot be undone. This will permanently delete the project and all its environments, services, and deployments."
						fallbackError="Failed to delete project"
						onDelete={handleDelete}
					/>
				</Item>
			</div>
		</div>
	);
}
