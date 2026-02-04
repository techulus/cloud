"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { createService, validateDockerImage } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { GitHubRepoSelector } from "@/components/github/github-repo-selector";

type SelectedRepo = {
	id?: number;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
	installationId?: number;
};

export function CreateServiceDialog({
	projectId,
	environmentId,
	projectSlug,
	envName,
	onSuccess,
	open: externalOpen,
	onOpenChange: onExternalOpenChange,
}: {
	projectId: string;
	environmentId: string;
	projectSlug: string;
	envName: string;
	onSuccess?: () => void;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const [internalOpen, setInternalOpen] = useState(false);
	const isOpen = externalOpen ?? internalOpen;
	const setIsOpen = (open: boolean) => {
		setInternalOpen(open);
		onExternalOpenChange?.(open);
	};
	const [name, setName] = useState("");
	const [image, setImage] = useState("");
	const [selectedRepo, setSelectedRepo] = useState<SelectedRepo | null>(null);
	const [branch, setBranch] = useState("main");
	const [rootDir, setRootDir] = useState("");
	const [stateful, setStateful] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDockerSubmit = async (e: React.FormEvent) => {
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
				stateful,
			});
			resetAndClose();
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

	const handleGitHubSubmit = async (e: React.FormEvent) => {
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
				stateful,
				github: {
					repoUrl: `https://github.com/${selectedRepo.fullName}`,
					branch: branch.trim() || selectedRepo.defaultBranch,
					rootDir: rootDir.trim() || undefined,
					installationId: selectedRepo.installationId,
					repoId: selectedRepo.id,
				},
			});
			resetAndClose();
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

	const resetAndClose = () => {
		setIsOpen(false);
		setName("");
		setImage("");
		setSelectedRepo(null);
		setBranch("main");
		setRootDir("");
		setStateful(false);
		setError(null);
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setName("");
			setImage("");
			setSelectedRepo(null);
			setBranch("main");
			setRootDir("");
			setStateful(false);
			setError(null);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button />}>Add Service</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New Service</DialogTitle>
				</DialogHeader>
				<Tabs defaultValue="docker">
					<TabsList>
						<TabsTrigger value="docker">Docker Image</TabsTrigger>
						<TabsTrigger value="github">GitHub Repo</TabsTrigger>
					</TabsList>
					<TabsContent value="docker">
						<form onSubmit={handleDockerSubmit} className="space-y-4 pt-4">
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
							<div className="flex items-center justify-between rounded-lg border p-3">
								<div className="space-y-0.5">
									<Label htmlFor="stateful-toggle">Stateful Service</Label>
									<p className="text-xs text-muted-foreground">
										Enable to add persistent volumes. Limited to 1 replica and
										locked to a single server.
									</p>
								</div>
								<Switch
									id="stateful-toggle"
									checked={stateful}
									onCheckedChange={setStateful}
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
								<Button
									type="submit"
									disabled={isLoading || !name.trim() || !image.trim()}
								>
									{isLoading ? "Creating..." : "Create"}
								</Button>
							</div>
						</form>
					</TabsContent>
					<TabsContent value="github">
						<form onSubmit={handleGitHubSubmit} className="space-y-4 pt-4">
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
							<div className="flex items-center justify-between rounded-lg border p-3">
								<div className="space-y-0.5">
									<Label htmlFor="gh-stateful-toggle">Stateful Service</Label>
									<p className="text-xs text-muted-foreground">
										Enable to add persistent volumes. Limited to 1 replica and
										locked to a single server.
									</p>
								</div>
								<Switch
									id="gh-stateful-toggle"
									checked={stateful}
									onCheckedChange={setStateful}
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
								<Button
									type="submit"
									disabled={isLoading || !name.trim() || !selectedRepo}
								>
									{isLoading ? "Creating..." : "Create"}
								</Button>
							</div>
						</form>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
