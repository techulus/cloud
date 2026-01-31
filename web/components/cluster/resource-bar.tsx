import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface ResourceBarProps {
	value: number;
	label: string;
	icon: ReactNode;
}

export function ResourceBar({ value, label, icon }: ResourceBarProps) {
	const color =
		value >= 90
			? "bg-rose-500"
			: value >= 70
				? "bg-amber-500"
				: "bg-emerald-500";

	return (
		<div className="space-y-1">
			<div className="flex items-center justify-between text-sm">
				<span className="flex items-center gap-2 text-muted-foreground">
					{icon}
					{label}
				</span>
				<span className="tabular-nums font-medium">{value.toFixed(1)}%</span>
			</div>
			<div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
				<div
					className={cn("h-full transition-all duration-500", color)}
					style={{ width: `${Math.min(value, 100)}%` }}
				/>
			</div>
		</div>
	);
}
