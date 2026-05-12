import { Suspense } from "react";
import { SignInPage } from "@/components/auth/sign-in-page";
import { Skeleton } from "@/components/ui/skeleton";

function RootPageSkeleton() {
	return (
		<div className="min-h-screen bg-background">
			<div
				aria-hidden="true"
				className="mx-auto flex min-h-screen w-full max-w-md items-center px-6"
			>
				<div className="w-full space-y-6">
					<div className="flex items-center gap-3">
						<Skeleton className="size-10 rounded-lg" />
						<div className="space-y-2">
							<Skeleton className="h-4 w-36" />
							<Skeleton className="h-3 w-24" />
						</div>
					</div>

					<div className="space-y-3">
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-full rounded-lg" />
						<Skeleton className="h-10 w-2/3 rounded-lg" />
					</div>
				</div>
			</div>
			<div aria-live="polite" className="sr-only">
				Loading
			</div>
		</div>
	);
}

export default function Page() {
	return (
		<Suspense fallback={<RootPageSkeleton />}>
			<SignInPage />
		</Suspense>
	);
}
