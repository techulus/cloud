"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { createEnvironment, deleteEnvironment } from "@/actions/projects";
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
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Environment } from "@/db/types";

type OptimisticAction =
	| { type: "add"; environment: Environment }
	| { type: "delete"; id: string };

export function EnvironmentManagement({
	projectId,
	environments,
}: {
	projectId: string;
	environments: Environment[];
}) {
	const router = useRouter();
	const [, startTransition] = useTransition();
	const [optimisticEnvironments, updateOptimistic] = useOptimistic(
		environments,
		(state, action: OptimisticAction) => {
			if (action.type === "add") {
				return [...state, action.environment];
			}
			if (action.type === "delete") {
				return state.filter((e) => e.id !== action.id);
			}
			return state;
		},
	);

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

		const trimmedName = name.trim();
		const tempId = crypto.randomUUID();

		startTransition(async () => {
			updateOptimistic({
				type: "add",
				environment: {
					id: tempId,
					projectId,
					name: trimmedName,
					createdAt: new Date(),
				},
			});

			try {
				await createEnvironment(projectId, trimmedName);
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
		});
	};

	const handleDelete = async (envId: string) => {
		setDeletingId(envId);

		startTransition(async () => {
			updateOptimistic({ type: "delete", id: envId });

			try {
				await deleteEnvironment(envId);
				router.refresh();
			} catch (err) {
				toast.error(
					err instanceof Error ? err.message : "Failed to delete environment",
				);
			} finally {
				setDeletingId(null);
			}
		});
	};

	return (
		<div className="divide-y rounded-lg border">
			<div className="flex items-center justify-between gap-4 px-3 py-2.5">
				<div className="min-w-0">
					<p className="text-sm font-medium">Environments</p>
					<p className="text-sm text-muted-foreground">
						Organize services by environment (e.g., production, staging)
					</p>
				</div>
				<Dialog open={isOpen} onOpenChange={setIsOpen}>
					<DialogTrigger render={<Button size="sm" variant="outline" />}>
						<Plus className="h-4 w-4" />
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
			{optimisticEnvironments.map((env) => (
				<div
					key={env.id}
					className="flex min-h-11 items-center justify-between gap-4 px-3 py-1.5"
				>
					<span className="truncate font-mono text-sm">{env.name}</span>
					{env.name === "production" ? (
						<span className="shrink-0 font-mono text-xs text-muted-foreground">
							default
						</span>
					) : (
						<AlertDialog>
							<AlertDialogTrigger
								render={
									<Button
										variant="ghost"
										size="icon"
										className="size-7 shrink-0"
										disabled={deletingId === env.id}
										aria-label={`Delete ${env.name}`}
										title={`Delete ${env.name}`}
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
				</div>
			))}
		</div>
	);
}
