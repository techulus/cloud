"use client";

import { memo, useState } from "react";
import { toast } from "sonner";
import { Box, GitBranch, Github, Loader2 } from "lucide-react";
import { updateServiceGithubRepo } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Item,
	ItemActions,
	ItemContent,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import type { ServiceWithDetails as Service } from "@/db/types";

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
	const [isSaving, setIsSaving] = useState(false);
	const [repoUrl, setRepoUrl] = useState(service.githubRepoUrl || "");
	const [branch, setBranch] = useState(service.githubBranch || "main");
	const [rootDir, setRootDir] = useState(service.githubRootDir || "");

	const { registry, repository, tag } = parseImageInfo(service.image);

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceGithubRepo(
				service.id,
				repoUrl || null,
				branch,
				rootDir,
			);
			toast.success("Repository settings updated");
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
		setIsEditing(false);
	};

	if (service.sourceType === "github" && service.githubRepoUrl) {
		return (
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Github className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Source</ItemTitle>
					</ItemContent>
					{!isEditing && (
						<ItemActions>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setIsEditing(true)}
							>
								Edit
							</Button>
						</ItemActions>
					)}
				</Item>
				<div className="p-4">
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
								<Button onClick={handleSave} disabled={isSaving} size="sm">
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
									{service.githubRepoUrl.replace("https://github.com/", "")}
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
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Box className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Source</ItemTitle>
				</ItemContent>
				{!isEditing && (
					<ItemActions>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setIsEditing(true)}
						>
							Connect GitHub
						</Button>
					</ItemActions>
				)}
			</Item>
			<div className="p-4">
				{isEditing ? (
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
								onClick={handleSave}
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
				)}
			</div>
		</div>
	);
});
