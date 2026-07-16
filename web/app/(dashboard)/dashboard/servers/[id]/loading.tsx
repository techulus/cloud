import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<div aria-hidden="true" className="space-y-6 px-4 py-2">
				<div className="grid min-h-72 overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
					<div className="flex flex-col gap-4 p-4">
						<div className="flex items-start justify-between gap-4">
							<Skeleton className="h-7 w-24" />
							<Skeleton className="h-7 w-44" />
						</div>
						<Skeleton className="min-h-40 flex-1 rounded-lg" />
					</div>
					<div className="space-y-3 border-t p-3 lg:border-t-0 lg:border-l">
						<Skeleton className="h-7 w-48" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="mt-4 h-24 w-full" />
					</div>
				</div>

				<div className="mx-auto max-w-5xl">
					<Skeleton className="h-36 rounded-xl" />
				</div>
			</div>
			<div aria-live="polite" className="sr-only">
				Loading server details
			</div>
		</>
	);
}
