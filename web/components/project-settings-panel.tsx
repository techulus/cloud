"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import {
	updateProjectName,
	updateProjectSlug,
	deleteProject,
} from "@/actions/projects";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { EditableText } from "@/components/editable-text";

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
					textClassName="text-lg font-medium"
				/>
			</div>
			<div className="p-4">
				<div className="text-sm text-muted-foreground mb-1">Project Slug</div>
				<EditableText
					value={project.slug}
					onChange={handleUpdateSlug}
					label="Project Slug"
					textClassName="text-lg font-medium font-mono"
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
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await deleteProject(project.id);
			toast.success("Project deleted");
			router.push("/dashboard");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete project",
			);
			setIsDeleting(false);
		}
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
					<AlertDialog>
						<AlertDialogTrigger render={<Button variant="destructive" />}>
							Delete Project
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
								<AlertDialogDescription>
									This action cannot be undone. This will permanently delete the
									project and all its environments, services, and deployments.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									onClick={handleDelete}
									disabled={isDeleting}
								>
									{isDeleting ? "Deleting..." : "Delete"}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</Item>
			</div>
		</div>
	);
}
