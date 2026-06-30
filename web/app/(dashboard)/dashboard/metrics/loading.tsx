import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: "Metrics", href: "/dashboard/metrics" },
				]}
			/>
			<div
				aria-hidden="true"
				className="container max-w-7xl mx-auto px-4 py-6 space-y-8"
			>
				<div className="space-y-2">
					<Skeleton className="h-8 w-32" />
					<Skeleton className="h-4 w-80 max-w-full" />
				</div>

				<section className="space-y-4">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="space-y-2">
							<Skeleton className="h-6 w-40" />
							<Skeleton className="h-4 w-72 max-w-full" />
						</div>
						<div className="flex gap-2">
							<Skeleton className="h-7 w-36 rounded-lg" />
							<Skeleton className="h-7 w-20 rounded-lg" />
						</div>
					</div>

					<div className="grid gap-4">
						{["cpu", "memory", "disk"].map((metric) => (
							<div
								key={metric}
								className="rounded-xl ring-1 ring-foreground/10"
							>
								<div className="flex items-center gap-3 border-b px-4 py-4">
									<Skeleton className="size-8 rounded-lg" />
									<div className="space-y-2">
										<Skeleton className="h-5 w-24" />
										<Skeleton className="h-4 w-56 max-w-full" />
									</div>
								</div>
								<div className="px-4 py-4">
									<Skeleton className="h-72 rounded-lg lg:h-80" />
								</div>
							</div>
						))}
					</div>
				</section>
			</div>
			<div aria-live="polite" className="sr-only">
				Loading metrics
			</div>
		</>
	);
}
