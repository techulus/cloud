"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { Globe, Lock, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

type GitHubRepo = {
	id: number;
	fullName: string;
	defaultBranch: string;
	private: boolean;
	installationId: number;
	accountLogin: string;
};

type SelectedRepo = {
	id?: number;
	fullName: string;
	defaultBranch: string;
	isPrivate: boolean;
	installationId?: number;
};

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function GitHubRepoSelector({
	value,
	onChange,
	disabled,
}: {
	value: SelectedRepo | null;
	onChange: (repo: SelectedRepo | null) => void;
	disabled?: boolean;
}) {
	const [search, setSearch] = useState("");

	const { data, isLoading } = useSWR<{
		repos: GitHubRepo[];
		installations: Array<{
			id: number;
			accountLogin: string;
			accountType: string;
		}>;
	}>("/api/github/repos", fetcher);

	const repos = data?.repos || [];
	const hasInstallations = (data?.installations?.length || 0) > 0;

	const filteredRepos = useMemo(() => {
		if (!search) return repos;
		const lower = search.toLowerCase();
		return repos.filter((r) => r.fullName.toLowerCase().includes(lower));
	}, [repos, search]);

	const isValidGitHubUrl = (url: string) => {
		const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/);
		return match ? match[1] : null;
	};

	const publicRepoFromSearch = useMemo(() => {
		const repoName = isValidGitHubUrl(search);
		if (!repoName) return null;
		const alreadyInList = repos.some(
			(r) => r.fullName.toLowerCase() === repoName.toLowerCase(),
		);
		if (alreadyInList) return null;
		return repoName;
	}, [search, repos]);

	const handleSelect = (repo: GitHubRepo) => {
		onChange({
			id: repo.id,
			fullName: repo.fullName,
			defaultBranch: repo.defaultBranch,
			isPrivate: repo.private,
			installationId: repo.installationId,
		});
		setSearch("");
	};

	const handleSelectPublic = (repoName: string) => {
		onChange({
			fullName: repoName,
			defaultBranch: "main",
			isPrivate: false,
			installationId: undefined,
		});
		setSearch("");
	};

	const handleClear = () => {
		onChange(null);
		setSearch("");
	};

	return (
		<div className="space-y-2">
			{value ? (
				<div className="flex items-center justify-between rounded-md border bg-muted/50 px-3 py-2">
					<span className="flex items-center gap-2 text-sm">
						{value.isPrivate ? (
							<Lock className="size-4 text-muted-foreground" />
						) : (
							<Globe className="size-4 text-muted-foreground" />
						)}
						{value.fullName}
					</span>
					<button
						type="button"
						onClick={handleClear}
						disabled={disabled}
						className="text-xs text-muted-foreground hover:text-foreground"
					>
						Change
					</button>
				</div>
			) : (
				<>
					<Input
						placeholder="Search or paste GitHub URL..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						disabled={disabled}
					/>
					<div className="max-h-48 overflow-y-auto rounded-md border">
						{isLoading ? (
							<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" />
								Loading repositories...
							</div>
						) : (
							<>
								{publicRepoFromSearch && (
									<div className="border-b p-1">
										<p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
											Public Repository
										</p>
										<button
											type="button"
											onClick={() => handleSelectPublic(publicRepoFromSearch)}
											className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
										>
											<Globe className="size-4" />
											<span>{publicRepoFromSearch}</span>
										</button>
									</div>
								)}

								{hasInstallations && filteredRepos.length > 0 && (
									<div className="p-1">
										<p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
											Connected Repositories
										</p>
										{filteredRepos.map((repo) => (
											<button
												type="button"
												key={repo.id}
												onClick={() => handleSelect(repo)}
												className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
											>
												{repo.private ? (
													<Lock className="size-4" />
												) : (
													<Globe className="size-4" />
												)}
												<span className="flex-1 truncate text-left">
													{repo.fullName}
												</span>
											</button>
										))}
									</div>
								)}

								{!hasInstallations && !publicRepoFromSearch && (
									<div className="space-y-1 p-4 text-center text-sm">
										<p>No GitHub App installed.</p>
										<p className="text-muted-foreground">
											Paste a public repo URL or install the GitHub App for
											private repos.
										</p>
									</div>
								)}

								{hasInstallations &&
									filteredRepos.length === 0 &&
									!publicRepoFromSearch && (
										<div className="space-y-1 p-4 text-center text-sm">
											<p>No matching repositories.</p>
											<p className="text-muted-foreground">
												Paste a public GitHub URL to use any public repo.
											</p>
										</div>
									)}
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
}
