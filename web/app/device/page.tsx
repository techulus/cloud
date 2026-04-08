import { Suspense } from "react";
import { DeviceAuthorizationPage } from "@/components/auth/device-authorization-page";
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
			<DeviceAuthorizationPage />
		</Suspense>
	);
}
