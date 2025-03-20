"use client";

import type { deployment, service } from "@/db/schema";
import { DockIcon } from "lucide-react";
import Link from "next/link";

export function ServiceItem({
	item,
}: {
	item: typeof service.$inferSelect & {
		deployments: (typeof deployment.$inferSelect)[];
	};
}) {
	return (
		<Link
			href={`/dashboard/project/${item.projectId}/${item.id}/deployments`}
			className={`group w-full max-w-sm rounded-xl ${
				item.deployments?.length === 0
					? "border-2 border-dashed border-blue-500 bg-blue-50 dark:bg-blue-950/20"
					: item.deployments?.some((d) => d.status === "pending")
						? "border-2 border-dashed border-yellow-500 bg-yellow-50 dark:bg-yellow-950/20 animate-pulse"
						: "border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"
			} p-6 transition-all duration-200 flex flex-col`}
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
						<span className="ml-2">{item?.configuration?.image}</span>
					</div>
				</div>
			</div>
		</Link>
	);
}
