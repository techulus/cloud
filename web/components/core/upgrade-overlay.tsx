"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getControlPlaneUpgradeStatus } from "@/actions/settings";
import type { ControlPlaneUpgradeState } from "@/lib/control-plane-updates";

const POLL_INTERVAL_MS = 4000;

export function ControlPlaneUpgradeOverlay({
	initialState,
}: {
	initialState: ControlPlaneUpgradeState | null;
}) {
	const [isActive, setIsActive] = useState(initialState?.status === "running");

	useEffect(() => {
		if (initialState?.status === "running") {
			setIsActive(true);
		}
	}, [initialState?.status]);

	useEffect(() => {
		if (!isActive) return;

		let cancelled = false;

		const interval = setInterval(async () => {
			try {
				const state = await getControlPlaneUpgradeStatus();
				if (cancelled) return;

				if (state.status === "succeeded") {
					window.location.reload();
				} else if (state.status === "failed") {
					toast.error(state.error ?? "Update failed");
					setIsActive(false);
				}
			} catch {
				// The stack restarts during the update, so requests are
				// expected to fail intermittently. Keep polling.
			}
		}, POLL_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [isActive]);

	if (!isActive) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
			<div className="mx-4 w-full max-w-sm rounded-lg border bg-background">
				<div className="flex items-center gap-2 border-b px-4 py-3">
					<span className="size-2 animate-pulse rounded-full bg-blue-500" />
					<span className="text-sm font-medium">
						Updating
						{initialState?.targetVersion
							? ` to ${initialState.targetVersion}`
							: ""}
					</span>
				</div>
				<p className="px-4 py-3 text-sm text-muted-foreground">
					The dashboard will reload automatically when the update completes.
					Actions are disabled until then.
				</p>
			</div>
		</div>
	);
}
