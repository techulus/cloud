import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Skeleton className="size-8 rounded-md" />
				<div className="flex-1 min-w-0">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<Skeleton className="h-8 w-28 rounded-md" />
						<Skeleton className="h-5 w-28" />
						<Skeleton className="h-5 w-36" />
						<Skeleton className="h-5 w-24" />
					</div>
				</div>
			</div>

			<div className="space-y-2">
				<Skeleton className="h-5 w-24" />
				<Skeleton className="h-[480px] rounded-lg" />
			</div>
		</div>
	);
}
