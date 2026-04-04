import { Suspense } from "react";
import { SignInPage } from "@/components/auth/sign-in-page";
import { Spinner } from "@/components/ui/spinner";

export default function Page() {
	return (
		<Suspense
			fallback={
				<div className="min-h-screen flex items-center justify-center">
					<Spinner className="size-6" />
				</div>
			}
		>
			<SignInPage />
		</Suspense>
	);
}
