"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { createService, validateDockerImage } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { GitHubRepoSelector } from "@/components/github/github-repo-selector";
import { Box, Github, Plus, Upload } from "lucide-react";
import Link from "next/link";

type SelectedRepo = {
	id?: number;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
	installationId?: number;
};

type ServiceDialogProps = {
	projectId: string;
	environmentId: string;
	projectSlug: string;
	envName: string;
	onSuccess?: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function AddServiceMenu({
	onSelectDocker,
	onSelectGitHub,
	composeHref,
}: {
	onSelectDocker: () => void;
	onSelectGitHub: () => void;
	composeHref: string;
}) {
	const [open, setOpen] = useState(false);

	const handleSelect = (cb: () => void) => {
		setOpen(false);
		cb();
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger render={<Button />}>
				<Plus className="h-4 w-4 mr-2" />
				Add Service
			</PopoverTrigger>
			<PopoverContent align="end" sideOffset={4} className="w-44 gap-0 p-1">
				<p className="px-2 py-1 text-xs font-medium text-muted-foreground">
					Add New Service
				</p>
				<button
					type="button"
					onClick={() => handleSelect(onSelectGitHub)}
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors cursor-pointer"
				>
					<Github className="h-4 w-4 text-muted-foreground shrink-0" />
					GitHub Repo
				</button>
				<button
					type="button"
					onClick={() => handleSelect(onSelectDocker)}
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors cursor-pointer"
				>
					<Box className="h-4 w-4 text-muted-foreground shrink-0" />
					Docker Image
				</button>
				<Link
					href={composeHref}
					onClick={() => setOpen(false)}
					className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors cursor-pointer"
				>
					<Upload className="h-4 w-4 text-muted-foreground shrink-0" />
					Import Compose
				</Link>
			</PopoverContent>
		</Popover>
	);
}

export function CreateDockerServiceDialog({
	projectId,
	environmentId,
	projectSlug,
	envName,
	onSuccess,
	open,
	onOpenChange,
}: ServiceDialogProps) {
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const [name, setName] = useState("");
	const [image, setImage] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !image.trim()) return;

		setIsLoading(true);
		setError(null);

		try {
			const validation = await validateDockerImage(image.trim());
			if (!validation.valid) {
				setError(validation.error || "Invalid image");
				setIsLoading(false);
				return;
			}

			const result = await createService({
				projectId,
				environmentId,
				name: name.trim(),
				image: image.trim(),
			});
			reset();
			onOpenChange(false);
			await mutate(`/api/projects/${projectId}/services`);
			onSuccess?.();
			router.push(
				`/dashboard/projects/${projectSlug}/${envName}/services/${result.id}/configuration`,
			);
		} catch (err) {
			console.error("Failed to create service:", err);
			setError("Failed to create service");
		} finally {
			setIsLoading(false);
		}
	};

	const reset = () => {
		setName("");
		setImage("");
		setError(null);
	};

	const handleOpenChange = (value: boolean) => {
		onOpenChange(value);
		if (!value) reset();
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Deploy Docker Image</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4 pt-4">
					<div className="space-y-2">
						<Label htmlFor="service-name">Service Name</Label>
						<Input
							id="service-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="my-service"
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="service-image">Docker Image</Label>
						<Input
							id="service-image"
							value={image}
							onChange={(e) => {
								setImage(e.target.value);
								setError(null);
							}}
							placeholder="nginx:latest"
						/>
						{error && <p className="text-sm text-red-500">{error}</p>}
						<p className="text-xs text-muted-foreground">
							Supported: Docker Hub, GitHub Container Registry (ghcr.io), or
							any public registry
						</p>
					</div>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={isLoading || !name.trim() || !image.trim()}
						>
							{isLoading ? "Creating..." : "Create"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function CreateGitHubServiceDialog({
	projectId,
	environmentId,
	projectSlug,
	envName,
	onSuccess,
	open,
	onOpenChange,
}: ServiceDialogProps) {
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const [name, setName] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
	const [branch, setBranch] = useState("main");
	const [rootDir, setRootDir] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !selectedRepo) return;

		setIsLoading(true);
		setError(null);

		try {
			const result = await createService({
				projectId,
				environmentId,
				name: name.trim(),
				image: "",
				github: {
					repoUrl: `https://github.com/${selectedRepo.fullName}`,
					branch: branch.trim() || selectedRepo.defaultBranch,
					rootDir: rootDir.trim() || undefined,
					installationId: selectedRepo.installationId,
					repoId: selectedRepo.id,
				},
			});
			reset();
			onOpenChange(false);
			await mutate(`/api/projects/${projectId}/services`);
			onSuccess?.();
			router.push(
				`/dashboard/projects/${projectSlug}/${envName}/services/${result.id}/configuration`,
			);
		} catch (err) {
			console.error("Failed to create service:", err);
			setError(err instanceof Error ? err.message : "Failed to create service");
		} finally {
			setIsLoading(false);
		}
	};

	const reset = () => {
		setName("");
		setSelectedRepo(null);
		setBranch("main");
		setRootDir("");
		setError(null);
	};

	const handleOpenChange = (value: boolean) => {
		onOpenChange(value);
		if (!value) reset();
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Deploy from GitHub</DialogTitle>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4 pt-4">
					<div className="space-y-2">
						<Label htmlFor="gh-service-name">Service Name</Label>
						<Input
							id="gh-service-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="my-service"
							autoFocus
						/>
					</div>
					<div className="space-y-2">
						<Label>Repository</Label>
						<GitHubRepoSelector
							value={selectedRepo}
							onChange={(repo) => {
								setSelectedRepo(repo);
								if (repo) {
									setBranch(repo.defaultBranch);
								}
								setError(null);
							}}
							disabled={isLoading}
						/>
						{error && <p className="text-sm text-red-500">{error}</p>}
					</div>
					<div className="space-y-2">
						<Label htmlFor="gh-branch">Branch</Label>
						<Input
							id="gh-branch"
							value={branch}
							onChange={(e) => setBranch(e.target.value)}
							placeholder="main"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="gh-root-dir">Root Directory</Label>
						<Input
							id="gh-root-dir"
							value={rootDir}
							onChange={(e) => setRootDir(e.target.value)}
							placeholder="apps/web"
						/>
						<p className="text-xs text-muted-foreground">
							Subdirectory containing the app (leave empty for repo root)
						</p>
					</div>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={isLoading || !name.trim() || !selectedRepo}
						>
							{isLoading ? "Creating..." : "Create"}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
