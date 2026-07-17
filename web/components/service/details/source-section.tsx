"use client";

import { GitBranch, Loader2 } from "lucide-react";
import { memo, useState } from "react";
import { toast } from "sonner";
import {
	updateServiceConfig,
	updateServiceGithubRepo,
	validateDockerImage,
} from "@/actions/projects";
import { ConfigSection } from "@/components/service/details/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ServiceWithDetails as Service } from "@/db/types";
import { imageNeedsProductionPinning } from "@/lib/docker-image";

function parseImageInfo(image: string): {
	registry: string;
	repository: string;
	tag: string;
} {
	let registry = "docker.io";
	let repository = image;
	let tag = "latest";

	if (repository.includes(":")) {
		const parts = repository.split(":");
		repository = parts[0];
		tag = parts[1] || "latest";
	}

	if (repository.includes("/")) {
		const slashCount = (repository.match(/\//g) || []).length;
		if (slashCount >= 2 || repository.split("/")[0].includes(".")) {
			const firstSlash = repository.indexOf("/");
			registry = repository.substring(0, firstSlash);
			repository = repository.substring(firstSlash + 1);
		}
	}

	return { registry, repository, tag };
}

export const SourceSection = memo(function SourceSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate?: () => void;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [editMode, setEditMode] = useState<"github" | "image">("image");
	const [isSaving, setIsSaving] = useState(false);
	const [repoUrl, setRepoUrl] = useState("");
	const [branch, setBranch] = useState("main");
	const [rootDir, setRootDir] = useState("");
	const [image, setImage] = useState("");
	const [imageError, setImageError] = useState<string | null>(null);

	const { registry, repository, tag } = parseImageInfo(service.image);

	const handleSaveGithub = async () => {
		setIsSaving(true);
		try {
			await updateServiceGithubRepo(
				service.id,
				repoUrl || null,
				branch,
				rootDir,
			);
			setIsEditing(false);
			onUpdate?.();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update");
		} finally {
			setIsSaving(false);
		}
	};

	const handleSaveImage = async () => {
		if (!image.trim()) return;
		setIsSaving(true);
		setImageError(null);
		try {
			const validation = await validateDockerImage(image.trim());
			if (!validation.valid) {
				setImageError(validation.error || "Invalid image");
				setIsSaving(false);
				return;
			}
			await updateServiceConfig(service.id, {
				source: { type: "image", image: image.trim() },
			});
			setIsEditing(false);
			onUpdate?.();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to update");
		} finally {
			setIsSaving(false);
		}
	};

	const handleCancel = () => {
		setRepoUrl(service.githubRepoUrl || "");
		setBranch(service.githubBranch || "main");
		setRootDir(service.githubRootDir || "");
		setImage(service.image);
		setImageError(null);
		setIsEditing(false);
	};

	const startEditImage = () => {
		setEditMode("image");
		setImage(service.image);
		setImageError(null);
		setIsEditing(true);
	};

	const startEditGithub = () => {
		setEditMode("github");
		setRepoUrl(service.githubRepoUrl || "");
		setBranch(service.githubBranch || "main");
		setRootDir(service.githubRootDir || "");
		setIsEditing(true);
	};

	if (service.sourceType === "github" && service.githubRepoUrl) {
		const repoPath = service.githubRepoUrl.replace("https://github.com/", "");

		return (
			<ConfigSection
				title="Source"
				summary={`${repoPath}@${service.githubBranch || "main"}`}
			>
				<div>
					{isEditing ? (
						<div className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="repo-url">Repository URL</Label>
								<Input
									id="repo-url"
									placeholder="https://github.com/owner/repo"
									value={repoUrl}
									onChange={(e) => setRepoUrl(e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="branch">Branch</Label>
								<Input
									id="branch"
									placeholder="main"
									value={branch}
									onChange={(e) => setBranch(e.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="root-dir">Root Directory</Label>
								<Input
									id="root-dir"
									placeholder="apps/web"
									value={rootDir}
									onChange={(e) => setRootDir(e.target.value)}
								/>
								<p className="text-xs text-muted-foreground">
									Subdirectory containing the app (leave empty for repo root)
								</p>
							</div>
							<div className="flex items-center gap-2">
								<Button
									onClick={handleSaveGithub}
									disabled={isSaving}
									size="sm"
								>
									{isSaving && (
										<Loader2 className="size-4 mr-1.5 animate-spin" />
									)}
									Save
								</Button>
								<Button
									variant="outline"
									onClick={handleCancel}
									disabled={isSaving}
									size="sm"
								>
									Cancel
								</Button>
							</div>
						</div>
					) : (
						<div className="space-y-4">
							<div className="grid gap-4 sm:grid-cols-3">
								<div className="space-y-1">
									<p className="text-xs font-medium text-muted-foreground">
										Repository
									</p>
									<a
										href={service.githubRepoUrl}
										target="_blank"
										rel="noopener noreferrer"
										className="text-sm font-mono text-primary hover:underline"
									>
										{repoPath}
									</a>
								</div>
								<div className="space-y-1">
									<p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
										<GitBranch className="size-3" />
										Branch
									</p>
									<p className="text-sm font-mono">
										{service.githubBranch || "main"}
									</p>
								</div>
								{service.githubRootDir && (
									<div className="space-y-1">
										<p className="text-xs font-medium text-muted-foreground">
											Root Directory
										</p>
										<p className="text-sm font-mono">{service.githubRootDir}</p>
									</div>
								)}
							</div>
							<Button variant="outline" size="sm" onClick={startEditGithub}>
								Edit
							</Button>
						</div>
					)}
				</div>
			</ConfigSection>
		);
	}

	return (
		<ConfigSection title="Source" summary={service.image}>
			<div>
				{isEditing && editMode === "image" ? (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="docker-image">Docker Image</Label>
							<Input
								id="docker-image"
								placeholder="nginx:1.27"
								value={image}
								onChange={(e) => {
									setImage(e.target.value);
									setImageError(null);
								}}
							/>
							{imageError && (
								<p className="text-sm text-red-500">{imageError}</p>
							)}
							{imageNeedsProductionPinning(image.trim()) && (
								<p className="text-xs text-amber-600">
									Use a version tag or digest for production. Unqualified images
									default to latest.
								</p>
							)}
							<p className="text-xs text-muted-foreground">
								Supported: Docker Hub, GitHub Container Registry (ghcr.io), or
								any public registry
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								onClick={handleSaveImage}
								disabled={isSaving || !image.trim()}
								size="sm"
							>
								{isSaving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
								Save
							</Button>
							<Button
								variant="outline"
								onClick={handleCancel}
								disabled={isSaving}
								size="sm"
							>
								Cancel
							</Button>
						</div>
					</div>
				) : isEditing && editMode === "github" ? (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="repo-url">Public GitHub Repository URL</Label>
							<Input
								id="repo-url"
								placeholder="https://github.com/owner/repo"
								value={repoUrl}
								onChange={(e) => setRepoUrl(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Enter a public GitHub repository URL to enable automatic builds.
							</p>
						</div>
						<div className="space-y-2">
							<Label htmlFor="branch">Branch</Label>
							<Input
								id="branch"
								placeholder="main"
								value={branch}
								onChange={(e) => setBranch(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="root-dir-connect">Root Directory</Label>
							<Input
								id="root-dir-connect"
								placeholder="apps/web"
								value={rootDir}
								onChange={(e) => setRootDir(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Subdirectory containing the app (leave empty for repo root)
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Button
								onClick={handleSaveGithub}
								disabled={isSaving || !repoUrl}
								size="sm"
							>
								{isSaving && <Loader2 className="size-4 mr-1.5 animate-spin" />}
								Connect
							</Button>
							<Button
								variant="outline"
								onClick={handleCancel}
								disabled={isSaving}
								size="sm"
							>
								Cancel
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-3">
							<div className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									Registry
								</p>
								<p className="text-sm font-mono">{registry}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									Repository
								</p>
								<p className="text-sm font-mono">{repository}</p>
							</div>
							<div className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">Tag</p>
								<p className="text-sm font-mono">{tag}</p>
							</div>
						</div>
						<div className="flex gap-2">
							<Button variant="outline" size="sm" onClick={startEditImage}>
								Edit
							</Button>
							<Button variant="outline" size="sm" onClick={startEditGithub}>
								Connect GitHub
							</Button>
						</div>
					</div>
				)}
			</div>
		</ConfigSection>
	);
});
