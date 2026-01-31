import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface HealthIndicatorProps {
	healthy: boolean | undefined | null;
	label: string;
	detail: string;
	icon: ReactNode;
}

export function HealthIndicator({
	healthy,
	label,
	detail,
	icon,
}: HealthIndicatorProps) {
	const isHealthy = healthy === true;

	return (
		<div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
			<div
				className={cn(
					"p-2 rounded-md",
					isHealthy
						? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
						: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
				)}
			>
				{icon}
			</div>
			<div>
				<p className="text-sm font-medium">{label}</p>
				<p className="text-xs text-muted-foreground">{detail}</p>
			</div>
		</div>
	);
}
