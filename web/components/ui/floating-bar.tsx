"use client";

import { cn } from "@/lib/utils";

type FloatingBarVariant = "default" | "success" | "error" | "info";

const variantStyles: Record<FloatingBarVariant, string> = {
	default: "border-zinc-300 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-800",
	success: "border-emerald-500 dark:border-emerald-600 bg-emerald-50 dark:bg-emerald-900/50",
	error: "border-red-500 dark:border-red-600 bg-red-50 dark:bg-red-900/50",
	info: "border-orange-500 dark:border-orange-600 bg-orange-50 dark:bg-orange-900/50",
};

export function FloatingBar({
	children,
	visible = true,
	variant = "default",
	className,
}: {
	children: React.ReactNode;
	visible?: boolean;
	variant?: FloatingBarVariant;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"fixed left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out w-[80%] sm:w-[30%]",
				visible
					? "bottom-2 sm:bottom-20 opacity-100"
					: "-bottom-24 opacity-0 pointer-events-none",
			)}
		>
			<div
				className={cn(
					"flex items-center justify-between gap-4 px-5 h-12 bg-zinc-100 dark:bg-zinc-800 border rounded-xl shadow-lg",
					variantStyles[variant],
					className,
				)}
			>
				{children}
			</div>
		</div>
	);
}
