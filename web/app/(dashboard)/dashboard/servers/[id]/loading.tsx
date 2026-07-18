import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<div aria-hidden="true" className="mx-auto max-w-5xl space-y-4 px-4 py-2">
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
