import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ServerDetailsSkeleton() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>Server Details</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid grid-cols-2 gap-4 md:grid-cols-3">
					{Array.from({ length: 9 }).map((_, index) => (
						<div key={index} className="space-y-2">
							<Skeleton className="h-3 w-24" />
							<Skeleton className="h-4 w-32 max-w-full" />
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function HealthMetricSkeleton() {
	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<Skeleton className="size-4 rounded" />
				<Skeleton className="h-4 w-16" />
			</div>
			<Skeleton className="h-2 w-full rounded-full" />
			<Skeleton className="h-3 w-10" />
		</div>
	);
}

function HealthStatusSkeleton() {
	return (
		<div className="flex items-start gap-3">
			<Skeleton className="size-8 rounded-md" />
			<div className="space-y-2">
				<Skeleton className="h-4 w-24" />
				<Skeleton className="h-3 w-16" />
			</div>
		</div>
	);
}

function SystemHealthSkeleton() {
	return (
		<Card>
			<CardHeader>
				<CardTitle>System Health</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid gap-4 sm:grid-cols-3">
					<HealthMetricSkeleton />
					<HealthMetricSkeleton />
					<HealthMetricSkeleton />
				</div>
				<div className="border-t pt-4">
					<div className="grid gap-4 sm:grid-cols-3">
						<HealthStatusSkeleton />
						<HealthStatusSkeleton />
						<HealthStatusSkeleton />
					</div>
				</div>
			</CardContent>
		</Card>
	);
}

function RunningServicesSkeleton() {
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Skeleton className="size-5 rounded" />
					<Skeleton className="h-5 w-36" />
				</CardTitle>
				<CardDescription>
					<Skeleton className="h-4 w-48" />
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid gap-3 md:grid-cols-2">
					{Array.from({ length: 4 }).map((_, index) => (
						<div
							key={index}
							className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5"
						>
							<Skeleton className="size-8 shrink-0 rounded-md" />
							<div className="min-w-0 flex-1 space-y-2">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-3 w-44 max-w-full" />
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

function AgentLogsSkeleton() {
	return (
		<div className="space-y-2">
			<h3 className="text-sm font-medium">Agent Logs</h3>
			<div className="flex h-[420px] flex-col overflow-hidden rounded-lg border bg-card">
				<div className="flex items-center gap-2 border-b p-3">
					<Skeleton className="h-9 w-64 max-w-full rounded-md" />
					<Skeleton className="ml-auto size-8 rounded-md" />
				</div>
				<div className="space-y-2 p-4">
					{Array.from({ length: 12 }).map((_, index) => (
						<Skeleton
							key={index}
							className="h-3"
							style={{ width: `${92 - (index % 5) * 9}%` }}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

function DangerZoneSkeleton() {
	return (
		<Card className="border-destructive/30">
			<CardHeader>
				<CardTitle>
					<Skeleton className="h-5 w-28" />
				</CardTitle>
				<CardDescription>
					<Skeleton className="h-4 w-72 max-w-full" />
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Skeleton className="h-9 w-32 rounded-md" />
			</CardContent>
		</Card>
	);
}

export default function Loading() {
	return (
		<>
			<SetBreadcrumbs
				items={[{ label: "Dashboard", href: "/dashboard" }]}
			/>
			<div
				aria-hidden="true"
				className="container max-w-7xl mx-auto px-4 py-6 space-y-6"
			>
				<div className="flex items-center gap-3">
					<Skeleton className="h-6 w-44" />
					<Skeleton className="size-3 rounded-full" />
					<Skeleton className="h-5 w-16 rounded-md" />
				</div>

				<ServerDetailsSkeleton />
				<SystemHealthSkeleton />
				<RunningServicesSkeleton />
				<AgentLogsSkeleton />
				<DangerZoneSkeleton />
			</div>
			<div aria-live="polite" className="sr-only">
				Loading server details
			</div>
		</>
	);
}
