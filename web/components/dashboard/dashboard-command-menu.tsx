"use client";

import {
	BoxIcon,
	FolderIcon,
	LayoutDashboardIcon,
	SearchIcon,
	ServerIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { fetcher } from "@/lib/fetcher";
import type {
	NavigationGroup,
	NavigationItem,
	NavigationResponse,
} from "@/lib/navigation";

const groups: NavigationGroup[] = ["Pages", "Projects", "Services", "Servers"];

function ResultIcon({ item }: { item: NavigationItem }) {
	const className = "size-4 text-muted-foreground";
	if (item.kind === "page")
		return <LayoutDashboardIcon className={className} />;
	if (item.kind === "service") return <BoxIcon className={className} />;
	if (item.kind === "server") return <ServerIcon className={className} />;
	return <FolderIcon className={className} />;
}

function NavigationResult({
	item,
	onSelect,
}: {
	item: NavigationItem;
	onSelect: (href: string) => void;
}) {
	return (
		<CommandItem
			value={`${item.label} ${item.description ?? ""} ${item.id}`}
			keywords={item.keywords}
			onSelect={() => onSelect(item.href)}
		>
			<ResultIcon item={item} />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{item.label}</span>
				{item.description && (
					<span className="block truncate text-xs text-muted-foreground">
						{item.description}
					</span>
				)}
			</span>
		</CommandItem>
	);
}

export function DashboardCommandMenu() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const commandListRef = useRef<HTMLDivElement>(null);
	const { data, error, isLoading, mutate } = useSWR<NavigationResponse>(
		open ? "/api/navigation" : null,
		fetcher,
		{
			dedupingInterval: 60_000,
			revalidateOnFocus: false,
			revalidateOnReconnect: false,
		},
	);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				setSearch("");
				setOpen((current) => !current);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, []);

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) setSearch("");
	};

	const handleSearchChange = (value: string) => {
		if (commandListRef.current) commandListRef.current.scrollTop = 0;
		setSearch(value);
	};

	const handleSelect = (href: string) => {
		setOpen(false);
		setSearch("");
		router.push(href);
	};

	return (
		<>
			<Button
				type="button"
				variant="outline"
				aria-label="Open navigation search"
				className="size-8 px-0 text-muted-foreground sm:w-48 sm:justify-between sm:px-2.5"
				onClick={() => setOpen(true)}
			>
				<span className="flex items-center gap-2">
					<SearchIcon className="size-4" />
					<span className="hidden sm:inline">Search…</span>
				</span>
				<kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-sans text-[10px] sm:inline">
					⌘K
				</kbd>
			</Button>

			<CommandDialog
				open={open}
				onOpenChange={handleOpenChange}
				title="Navigation search"
				description="Search dashboard pages, projects, services, and servers."
			>
				<Command loop>
					<CommandInput
						value={search}
						onValueChange={handleSearchChange}
						placeholder="Search pages, projects, services, and servers…"
					/>
					<CommandList ref={commandListRef}>
						{isLoading ? (
							<div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
								<Spinner />
								Loading navigation…
							</div>
						) : error ? (
							<div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
								<p className="text-sm text-muted-foreground">
									Could not load navigation. Try again.
								</p>
								<Button size="sm" variant="outline" onClick={() => mutate()}>
									Retry
								</Button>
							</div>
						) : (
							<>
								<CommandEmpty>No pages found.</CommandEmpty>
								{search.trim()
									? data?.items.map((item) => (
											<NavigationResult
												key={item.id}
												item={item}
												onSelect={handleSelect}
											/>
										))
									: groups.map((group) => {
											const items = data?.items.filter(
												(item) => item.group === group,
											);
											if (!items?.length) return null;

											return (
												<CommandGroup key={group} heading={group}>
													{items.map((item) => (
														<NavigationResult
															key={item.id}
															item={item}
															onSelect={handleSelect}
														/>
													))}
												</CommandGroup>
											);
										})}
							</>
						)}
					</CommandList>
				</Command>
			</CommandDialog>
		</>
	);
}
