"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function ServerTabs({ serverId }: { serverId: string }) {
	const pathname = usePathname();
	const basePath = `/dashboard/servers/${serverId}`;
	const tabs = [
		{ name: "Overview", href: basePath },
		{ name: "Logs", href: `${basePath}/logs` },
		{ name: "Settings", href: `${basePath}/settings` },
	];

	return (
		<div className="overflow-x-auto px-4 py-3">
			<nav
				aria-label="Server sections"
				className="inline-flex w-max items-center rounded-lg bg-muted p-[3px]"
			>
				{tabs.map((tab) => {
					const isActive =
						tab.href === basePath
							? pathname === basePath
							: pathname.startsWith(tab.href);

					return (
						<Link
							key={tab.href}
							href={tab.href}
							aria-current={isActive ? "page" : undefined}
							className={cn(
								"shrink-0 whitespace-nowrap rounded-md border border-transparent px-3 py-1.5 text-sm font-medium transition-all",
								isActive
									? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{tab.name}
						</Link>
					);
				})}
			</nav>
		</div>
	);
}
