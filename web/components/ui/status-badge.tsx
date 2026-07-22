import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, "children"> & {
	icon: React.ComponentType<{ className?: string }>;
	label: string;
	isAnimated?: boolean;
	size?: "default" | "sm";
};

function StatusBadge({
	icon: Icon,
	label,
	isAnimated = false,
	className,
	variant = "outline",
	size = "default",
	...props
}: StatusBadgeProps) {
	return (
		<Badge
			variant={variant}
			className={cn(
				"h-auto border-transparent bg-current/10 font-mono font-bold uppercase",
				size === "sm"
					? "px-1.5 py-0.5 text-[10px] [&>svg]:size-3!"
					: "px-2 py-1 text-[11px] [&>svg]:size-3.5!",
				className,
			)}
			{...props}
		>
			<Icon className={isAnimated ? "animate-spin" : undefined} />
			{label}
		</Badge>
	);
}

export { StatusBadge };
