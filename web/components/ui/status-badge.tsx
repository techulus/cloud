import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, "children"> & {
	icon: React.ComponentType<{ className?: string }>;
	label: string;
	isAnimated?: boolean;
};

function StatusBadge({
	icon: Icon,
	label,
	isAnimated = false,
	className,
	variant = "outline",
	...props
}: StatusBadgeProps) {
	return (
		<Badge
			variant={variant}
			className={cn(
				"h-auto border-transparent bg-current/10 px-2 py-1 font-mono text-[11px] font-bold uppercase [&>svg]:size-3.5!",
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
