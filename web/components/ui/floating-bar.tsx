"use client";

import { cn } from "@/lib/utils";

export function FloatingBar({
	children,
	visible = true,
	progress = false,
	className,
}: {
	children: React.ReactNode;
	visible?: boolean;
	progress?: boolean;
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
			{progress ? (
				<div className="relative rounded-lg p-[2px] overflow-hidden shadow-sm border border-border">
					<div
						className="absolute inset-0 animate-spin-slow"
						style={{
							background:
								"conic-gradient(from 0deg, transparent, #f97316, transparent 40%)",
						}}
					/>
					<div
						className={cn(
							"relative flex items-center justify-between gap-4 px-4 h-12 rounded-lg",
							"bg-popover text-popover-foreground",
							className,
						)}
					>
						{children}
					</div>
				</div>
			) : (
				<div
					className={cn(
						"flex items-center justify-between gap-4 px-4 h-12 rounded-lg border shadow-sm",
						"bg-popover text-popover-foreground border-border",
						className,
					)}
				>
					{children}
				</div>
			)}
		</div>
	);
}
