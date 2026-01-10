"use client";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export function FloatingBar({
	visible = true,
	loading = false,
	status,
	action,
}: {
	visible?: boolean;
	loading?: boolean;
	status: string;
	action?: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"fixed left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out w-3/4 sm:w-1/4",
				visible
					? "bottom-8 opacity-100"
					: "-bottom-16 opacity-0 pointer-events-none",
			)}
		>
			<div className="flex items-center justify-between gap-3 px-5 py-3 rounded-full bg-black text-white shadow-xl border border-white/10">
				{loading && <Spinner className="shrink-0" />}
				<span className="text-sm font-medium">{status}</span>
				{action}
			</div>
		</div>
	);
}
