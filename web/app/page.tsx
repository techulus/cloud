import { Suspense } from "react";
import { SignInPage } from "@/components/auth/sign-in-page";
import { DashboardPageSkeleton } from "@/components/dashboard/dashboard-page-skeleton";

export default function Page() {
	return (
		<Suspense fallback={<DashboardPageSkeleton />}>
			<SignInPage />
		</Suspense>
	);
}
