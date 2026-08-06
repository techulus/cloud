import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ServerDetailsSkeleton({ className }: { className: string }) {
	return (
		<>
			<div aria-hidden="true" className={cn("space-y-4", className)}>
				<Skeleton className="h-6 w-48" />
				<Skeleton className="h-4 w-72 max-w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
			<div aria-live="polite" className="sr-only">
				Loading server details
			</div>
		</>
	);
}
