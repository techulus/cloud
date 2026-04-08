import { Suspense } from "react";
import { DeviceApprovalPage } from "@/components/auth/device-approval-page";
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
			<DeviceApprovalPage />
		</Suspense>
	);
}
