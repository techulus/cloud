"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Layers, Plus, Trash2 } from "lucide-react";
import { createEnvironment, deleteEnvironment } from "@/actions/projects";
import type { Environment } from "@/db/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
import {
	Item,
	ItemContent,
	ItemGroup,
	ItemMedia,
	ItemTitle,
	ItemDescription,
	ItemActions,
} from "@/components/ui/item";

export function EnvironmentManagement({
	projectId,
	initialEnvironments,
}: {
	projectId: string;
	initialEnvironments: Environment[];
}) {
	const router = useRouter();
	const [environments, setEnvironments] =
		useState<Environment[]>(initialEnvironments);
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deletingId, setDeletingId] = useState<string | null>(null);

	const handleCreate = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsLoading(true);
		setError(null);

		try {
			const result = await createEnvironment(projectId, name.trim());
			setEnvironments([
				...environments,
				{
					id: result.id,
					projectId,
					name: result.name,
					createdAt: new Date(),
				},
			]);
			setName("");
			setIsOpen(false);
			router.refresh();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to create environment",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleDelete = async (envId: string) => {
		setDeletingId(envId);
		try {
			await deleteEnvironment(envId);
			setEnvironments(environments.filter((e) => e.id !== envId));
			router.refresh();
		} catch (err) {
			console.error("Failed to delete environment:", err);
		} finally {
			setDeletingId(null);
		}
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold">Environments</h2>
					<p className="text-sm text-muted-foreground">
						Organize services by environment (e.g., production, staging)
					</p>
				</div>
				<Dialog open={isOpen} onOpenChange={setIsOpen}>
					<DialogTrigger render={<Button size="sm" />}>
						<Plus className="h-4 w-4 mr-1" />
						Add
					</DialogTrigger>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>New Environment</DialogTitle>
						</DialogHeader>
						<form onSubmit={handleCreate} className="space-y-4 pt-4">
							<div className="space-y-2">
								<Label htmlFor="env-name">Environment Name</Label>
								<Input
									id="env-name"
									value={name}
									onChange={(e) => {
										setName(e.target.value);
										setError(null);
									}}
									placeholder="staging"
									autoFocus
								/>
								{error && <p className="text-sm text-red-500">{error}</p>}
							</div>
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setIsOpen(false)}
								>
									Cancel
								</Button>
								<Button type="submit" disabled={isLoading || !name.trim()}>
									{isLoading ? "Creating..." : "Create"}
								</Button>
							</div>
						</form>
					</DialogContent>
				</Dialog>
			</div>

			<ItemGroup className="rounded-lg border py-3">
				{environments.map((env) => (
					<Item key={env.id}>
						<ItemMedia variant="icon">
							<Layers className="size-5" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>{env.name}</ItemTitle>
						</ItemContent>
						<ItemActions>
							{env.name !== "production" && (
								<AlertDialog>
									<AlertDialogTrigger
										render={
											<Button
												variant="ghost"
												size="icon"
												disabled={deletingId === env.id}
											/>
										}
									>
										<Trash2 className="h-4 w-4 text-destructive" />
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>Delete {env.name}?</AlertDialogTitle>
											<AlertDialogDescription>
												This will permanently delete this environment and all
												services within it. This action cannot be undone.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>Cancel</AlertDialogCancel>
											<AlertDialogAction
												variant="destructive"
												onClick={() => handleDelete(env.id)}
												disabled={deletingId === env.id}
											>
												{deletingId === env.id ? "Deleting..." : "Delete"}
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
						</ItemActions>
					</Item>
				))}
			</ItemGroup>
		</div>
	);
}
