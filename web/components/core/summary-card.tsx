import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export const SUMMARY_CARD_MIN_HEIGHT = 148;

export const SUMMARY_CARD_CLASSNAME =
	"group flex w-full flex-col rounded-xl border border-slate-200 dark:border-slate-700 bg-white/50 dark:bg-slate-900/50 px-3.5 py-3 transition-all duration-200 hover:ring hover:ring-primary/25 dark:hover:ring-primary/55";

export function SummaryCardTitle({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h3
			className={cn(
				"truncate font-semibold text-[15px] text-foreground",
				className,
			)}
		>
			{children}
		</h3>
	);
}

export function SummaryCardLine({
	icon: Icon,
	value,
}: {
	icon: LucideIcon;
	value: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2.5 text-xs leading-5">
			<Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 truncate font-mono text-foreground">
				{value}
			</span>
		</div>
	);
}

export function SummaryCardStat({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2 text-xs leading-5">
			<span className="font-mono uppercase tracking-wider text-muted-foreground">
				{label}
			</span>
			<span className="mb-[3px] flex-1 border-b border-dotted border-slate-300 opacity-50 dark:border-slate-600" />
			{children}
		</div>
	);
}

export function SummaryCardValue({ children }: { children: ReactNode }) {
	return (
		<span className="font-mono text-xs font-semibold text-foreground">
			{children}
		</span>
	);
}
