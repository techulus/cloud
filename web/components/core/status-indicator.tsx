export function StatusIndicator({ status }: { status: string }) {
	const colors: Record<string, { dot: string; text: string }> = {
		online: {
			dot: "bg-emerald-500",
			text: "text-emerald-600 dark:text-emerald-400",
		},
		pending: {
			dot: "bg-amber-500",
			text: "text-amber-600 dark:text-amber-400",
		},
		offline: {
			dot: "bg-rose-500",
			text: "text-rose-600 dark:text-rose-400",
		},
		unknown: {
			dot: "bg-zinc-400",
			text: "text-zinc-500",
		},
	};

	const color = colors[status] || colors.unknown;

	return (
		<div className="flex items-center gap-1.5">
			<span className="relative flex h-2 w-2">
				{status === "online" && (
					<span
						className={`animate-ping absolute inline-flex h-full w-full rounded-full ${color.dot} opacity-75`}
					/>
				)}
				<span
					className={`relative inline-flex rounded-full h-2 w-2 ${color.dot}`}
				/>
			</span>
			<span className={`text-xs font-medium capitalize ${color.text}`}>
				{status}
			</span>
		</div>
	);
}
