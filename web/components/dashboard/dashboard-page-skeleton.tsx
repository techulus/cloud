import { Skeleton } from "@/components/ui/skeleton";

export function DashboardPageSkeleton() {
	return (
		<div className="min-h-screen bg-background">
			<header className="border-b">
				<div className="container max-w-full mx-auto px-4 h-14 flex items-center justify-between">
					<Skeleton className="h-4 w-36" />
					<Skeleton className="size-8 rounded-md" />
				</div>
			</header>
			<main
				aria-hidden="true"
				className="container max-w-7xl mx-auto px-4 py-6 space-y-8"
			>
				<Skeleton className="h-24 rounded-lg" />
				<Skeleton className="h-48 rounded-xl" />
				<Skeleton className="h-36 rounded-xl" />
			</main>
			<div aria-live="polite" className="sr-only">
				Loading dashboard
			</div>
		</div>
	);
}
