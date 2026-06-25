import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<SetBreadcrumbs items={[{ label: "Dashboard", href: "/dashboard" }]} />
			<div
				aria-hidden="true"
				className="container max-w-7xl mx-auto px-4 py-6 space-y-6"
			>
				<div className="flex items-center gap-3">
					<Skeleton className="h-6 w-44" />
					<Skeleton className="size-3 rounded-full" />
					<Skeleton className="h-5 w-16 rounded-md" />
				</div>

				<Skeleton className="h-32 rounded-xl" />
				<Skeleton className="h-40 rounded-xl" />
				<Skeleton className="h-36 rounded-xl" />
				<Skeleton className="h-[420px] rounded-lg" />
			</div>
			<div aria-live="polite" className="sr-only">
				Loading server details
			</div>
		</>
	);
}
