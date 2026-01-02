"use client";

import { useState, useMemo } from "react";
import useSWR from "swr";
import { Check, ChevronsUpDown, Github, Globe, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";

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
	const [open, setOpen] = useState(false);
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
		setOpen(false);
		setSearch("");
	};

	const handleSelectPublic = (repoName: string) => {
		onChange({
			fullName: repoName,
			defaultBranch: "main",
			isPrivate: false,
			installationId: undefined,
		});
		setOpen(false);
		setSearch("");
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						variant="outline"
						role="combobox"
						aria-expanded={open}
						className="w-full justify-between font-normal"
						disabled={disabled}
					/>
				}
			>
				{value ? (
					<span className="flex items-center gap-2 truncate">
						{value.isPrivate ? (
							<Lock className="size-4 text-muted-foreground shrink-0" />
						) : (
							<Globe className="size-4 text-muted-foreground shrink-0" />
						)}
						{value.fullName}
					</span>
				) : (
					<span className="text-muted-foreground">Select repository...</span>
				)}
				<ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent className="w-[400px] p-0" align="start">
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search or paste GitHub URL..."
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList>
						{isLoading ? (
							<div className="py-6 text-center text-sm text-muted-foreground">
								Loading repositories...
							</div>
						) : (
							<>
								{publicRepoFromSearch && (
									<CommandGroup heading="Public Repository">
										<CommandItem
											onSelect={() => handleSelectPublic(publicRepoFromSearch)}
											className="cursor-pointer"
										>
											<Globe className="mr-2 size-4" />
											<span>{publicRepoFromSearch}</span>
										</CommandItem>
									</CommandGroup>
								)}

								{publicRepoFromSearch && filteredRepos.length > 0 && (
									<CommandSeparator />
								)}

								{hasInstallations && filteredRepos.length > 0 && (
									<CommandGroup heading="Connected Repositories">
										{filteredRepos.map((repo) => (
											<CommandItem
												key={repo.id}
												value={repo.fullName}
												onSelect={() => handleSelect(repo)}
												className="cursor-pointer"
											>
												{repo.private ? (
													<Lock className="mr-2 size-4" />
												) : (
													<Globe className="mr-2 size-4" />
												)}
												<span className="flex-1 truncate">{repo.fullName}</span>
												{value?.fullName === repo.fullName && (
													<Check className="ml-2 size-4" />
												)}
											</CommandItem>
										))}
									</CommandGroup>
								)}

								{!hasInstallations && !publicRepoFromSearch && (
									<CommandEmpty>
										<div className="space-y-2 p-2">
											<p>No GitHub App installed.</p>
											<p className="text-muted-foreground">
												Paste a public repo URL or install the GitHub App for
												private repos.
											</p>
										</div>
									</CommandEmpty>
								)}

								{hasInstallations &&
									filteredRepos.length === 0 &&
									!publicRepoFromSearch && (
										<CommandEmpty>
											<div className="space-y-2 p-2">
												<p>No matching repositories.</p>
												<p className="text-muted-foreground">
													Paste a public GitHub URL to use any public repo.
												</p>
											</div>
										</CommandEmpty>
									)}
							</>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
