"use client";

import type { service } from "@/db/schema";
import { DockIcon } from "lucide-react";
import Link from "next/link";

export function ServiceItem({
	item,
}: {
	item: typeof service.$inferSelect;
}) {
	const configuration = JSON.parse(item.configuration || "{}");

	return (
		<Link
			href={`/dashboard/project/${item.projectId}/${item.id}/deployments`}
			className="group w-full max-w-sm bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 transition-all duration-200 flex flex-col"
		>
			<div className="flex-1">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
						{item.name}
					</h3>
				</div>
				<div className="mt-4 space-y-2">
					<div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400">
						<span className="font-medium">
							<DockIcon className="w-6 h-6" />
						</span>
						<span className="ml-2">{configuration?.image}</span>
					</div>
				</div>
			</div>
		</Link>
	);
}
