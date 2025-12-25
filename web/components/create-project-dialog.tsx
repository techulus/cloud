"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createProject } from "@/actions/projects";
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

export function CreateProjectDialog() {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [isLoading, setIsLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;

		setIsLoading(true);
		try {
			const project = await createProject(name.trim());
			setIsOpen(false);
			setName("");
			router.push(`/dashboard/projects/${project.slug}`);
		} catch (error) {
			console.error("Failed to create project:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setName("");
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button />}>New Project</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New Project</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="project-name">Project Name</Label>
						<Input
							id="project-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="my-project"
							autoFocus
						/>
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
	);
}
