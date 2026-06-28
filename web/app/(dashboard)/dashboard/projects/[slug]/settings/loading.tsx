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
				<div className="rounded-lg border divide-y">
					<div className="p-4 space-y-2">
						<Skeleton className="h-4 w-24" />
						<Skeleton className="h-7 w-48" />
					</div>
					<div className="p-4 space-y-2">
						<Skeleton className="h-4 w-20" />
						<Skeleton className="h-7 w-40" />
						<Skeleton className="h-4 w-80 max-w-full" />
					</div>
				</div>

				<div className="space-y-4">
					<div className="flex items-center justify-between gap-4">
						<div className="space-y-2">
							<Skeleton className="h-5 w-32" />
							<Skeleton className="h-4 w-72 max-w-full" />
						</div>
						<Skeleton className="h-8 w-16 rounded-md" />
					</div>

					<div className="rounded-lg border py-3">
						{[0, 1, 2].map((item) => (
							<div key={item} className="flex items-center gap-3 px-4 py-3">
								<Skeleton className="size-9 rounded-md" />
								<Skeleton className="h-5 w-32" />
								<div className="ml-auto">
									<Skeleton className="size-8 rounded-md" />
								</div>
							</div>
						))}
					</div>
				</div>

				<div className="space-y-3">
					<Skeleton className="h-7 w-32" />
					<div className="rounded-lg border border-destructive/50 p-4">
						<div className="flex items-center gap-3">
							<Skeleton className="size-9 rounded-md" />
							<div className="space-y-2">
								<Skeleton className="h-5 w-36" />
								<Skeleton className="h-4 w-96 max-w-full" />
							</div>
							<div className="ml-auto">
								<Skeleton className="h-9 w-28 rounded-md" />
							</div>
						</div>
					</div>
				</div>
			</div>
			<div aria-live="polite" className="sr-only">
				Loading project settings
			</div>
		</>
	);
}
