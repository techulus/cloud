"use client";

import { ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

export function ConfigSection({
	title,
	summary,
	summaryMuted = false,
	keepMounted = false,
	children,
}: {
	title: string;
	summary?: ReactNode;
	summaryMuted?: boolean;
	keepMounted?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);

	return (
		<section>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
			>
				<span className="shrink-0 text-sm font-medium">{title}</span>
				<span className="flex min-w-0 items-center gap-2">
					{summary != null ? (
						<span
							className={cn(
								"truncate font-mono text-sm",
								summaryMuted ? "text-muted-foreground" : "text-foreground",
							)}
						>
							{summary}
						</span>
					) : null}
					<ChevronDown
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-180",
						)}
					/>
				</span>
			</button>
			{open || keepMounted ? (
				<div className={cn("border-t px-3 py-3", !open && "hidden")}>
					{children}
				</div>
			) : null}
		</section>
	);
}
