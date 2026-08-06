"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
				// Polled via a route handler instead of a server action: action IDs
				// change across builds, so once the updated control plane comes up
				// the old action reference 404s forever and the overlay never clears.
				const response = await fetch("/api/update-status");
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const state: ControlPlaneUpgradeState = await response.json();
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
			<div
				className="mx-4 w-full max-w-sm overflow-hidden rounded-xl border bg-background shadow-xl"
				role="status"
				aria-live="polite"
			>
				<div className="flex flex-col items-center px-6 py-7 text-center">
					<div className="relative mb-5 flex size-20 items-center justify-center">
						<span className="absolute inset-2 animate-ping rounded-full bg-primary/15 motion-reduce:hidden" />
						<span className="absolute inset-0 animate-spin rounded-full border border-dashed border-primary/40 [animation-duration:8s] motion-reduce:animate-none" />
						<span className="absolute inset-2 rounded-full border border-primary/15 bg-primary/5" />
						<RefreshCw className="relative size-8 animate-spin text-primary [animation-duration:2.5s] motion-reduce:animate-none" />
					</div>
					<p className="text-base font-medium">
						Updating
						{initialState?.targetVersion
							? ` to ${initialState.targetVersion}`
							: ""}
					</p>
					<p className="mt-2 max-w-xs text-sm text-muted-foreground">
						The dashboard will reload automatically when the update completes.
						Actions are disabled until then.
					</p>
				</div>
				<div className="relative h-1 overflow-hidden bg-muted">
					<span className="absolute inset-y-0 -left-1/2 w-1/2 animate-shimmer bg-gradient-to-r from-transparent via-primary to-transparent motion-reduce:left-0 motion-reduce:w-full motion-reduce:animate-none" />
				</div>
			</div>
		</div>
	);
}
