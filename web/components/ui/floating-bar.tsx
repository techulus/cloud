"use client";

import { cn } from "@/lib/utils";

type FloatingBarVariant = "default" | "success" | "error" | "info";

const variantStyles: Record<FloatingBarVariant, string> = {
	default: "border-zinc-300 dark:border-zinc-600",
	success: "border-emerald-500 dark:border-emerald-600",
	error: "border-red-500 dark:border-red-600",
	info: "border-blue-500 dark:border-blue-600",
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
				"fixed left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out w-[90%] sm:w-auto",
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
