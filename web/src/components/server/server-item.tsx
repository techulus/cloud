"use client";

import type { server } from "@/db/schema";
import { KeyIcon, ServerCog } from "lucide-react";
import Link from "next/link";

export default function ServerItem({
	item,
}: { item: typeof server.$inferSelect }) {
	return (
		<Link
			href={`/servers/${item.id}`}
			className="group w-full max-w-sm bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-800 p-6 transition-all duration-200 flex flex-col"
		>
			<div className="flex items-center justify-between">
				<h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
					<ServerCog className="w-4 h-4 inline-block" />
					{item.name}
				</h3>
			</div>
			<div className="mt-4 space-y-2">
				<div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400 font-mono">
					<KeyIcon className="w-4 h-4" />
					<span className="ml-2">{item.token}</span>
				</div>

				<div className="flex items-center text-sm text-zinc-500 dark:text-zinc-400 font-mono">
					<KeyIcon className="w-4 h-4" />
					<span className="ml-2">{item.secret}</span>
				</div>
			</div>
		</Link>
	);
}
