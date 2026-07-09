import { Suspense } from "react";
import { TwoFactorChallengePage } from "@/components/auth/two-factor-challenge-page";
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
			<TwoFactorChallengePage />
		</Suspense>
	);
}
