"use client";

import { cn } from "@/lib/utils";

export function FloatingBar({
	children,
	visible = true,
	className,
}: {
	children: React.ReactNode;
	visible?: boolean;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"fixed left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out w-[90%] sm:w-auto sm:min-w-[320px] sm:max-w-[420px]",
				visible
					? "bottom-12 opacity-100"
					: "-bottom-24 opacity-0 pointer-events-none",
			)}
		>
			<div
				className={cn(
					"flex items-center justify-between gap-4 px-4 py-3 rounded-lg border shadow-lg",
					"bg-popover text-popover-foreground border-border",
					className,
				)}
			>
				{children}
			</div>
		</div>
	);
}
