import { Skeleton } from "@/components/ui/skeleton";

function DashboardHeaderSkeleton() {
	return (
		<header className="border-b">
			<div className="container max-w-full mx-auto px-4 h-14 flex items-center justify-between">
				<div className="flex items-center gap-3">
					<Skeleton className="size-6 rounded" />
					<Skeleton className="h-4 w-28" />
				</div>
				<Skeleton className="size-8 rounded-md" />
			</div>
		</header>
	);
}

function ProjectCardSkeleton() {
	return (
		<div className="min-h-[80px] rounded-lg border p-4">
			<div className="flex h-full gap-3">
				<Skeleton className="size-10 shrink-0 rounded-md" />
				<div className="flex min-w-0 flex-1 flex-col justify-between">
					<Skeleton className="h-4 w-2/3" />
					<Skeleton className="h-3 w-20" />
				</div>
			</div>
		</div>
	);
}

function ServerRowSkeleton() {
	return (
		<div className="rounded-lg border p-4">
			<div className="flex items-center justify-between gap-4">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<Skeleton className="size-10 shrink-0 rounded-md" />
					<div className="min-w-0 flex-1 space-y-2">
						<Skeleton className="h-4 w-40" />
						<Skeleton className="h-3 w-56 max-w-full" />
					</div>
				</div>
				<Skeleton className="hidden h-8 w-24 rounded-md sm:block" />
			</div>
		</div>
	);
}

export function DashboardPageSkeleton() {
	return (
		<div className="min-h-screen bg-background">
			<DashboardHeaderSkeleton />
			<main
				aria-hidden="true"
				className="container max-w-7xl mx-auto px-4 py-6 space-y-12"
			>
				<section className="grid gap-4 md:grid-cols-3">
					<Skeleton className="h-24 rounded-lg" />
					<Skeleton className="h-24 rounded-lg" />
					<Skeleton className="h-24 rounded-lg" />
				</section>

				<section className="space-y-6">
					<div className="flex items-center justify-between gap-4">
						<div className="space-y-2">
							<Skeleton className="h-5 w-24" />
							<Skeleton className="h-4 w-44" />
						</div>
						<Skeleton className="h-9 w-28 rounded-md" />
					</div>
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
						<ProjectCardSkeleton />
						<ProjectCardSkeleton />
						<ProjectCardSkeleton />
					</div>
				</section>

				<section className="space-y-4">
					<div className="flex items-center justify-between gap-4">
						<div className="space-y-2">
							<Skeleton className="h-5 w-20" />
							<Skeleton className="h-4 w-36" />
						</div>
						<Skeleton className="h-9 w-28 rounded-md" />
					</div>
					<div className="space-y-3">
						<ServerRowSkeleton />
						<ServerRowSkeleton />
					</div>
				</section>
			</main>
			<div aria-live="polite" className="sr-only">
				Loading dashboard
			</div>
		</div>
	);
}
