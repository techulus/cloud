import { Suspense } from "react";
import { SignInPage, SignInPageSkeleton } from "@/components/auth/sign-in-page";

export default function Page() {
	return (
		<Suspense fallback={<SignInPageSkeleton />}>
			<SignInPage />
		</Suspense>
	);
}
