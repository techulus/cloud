"use client";

import { ArrowUpCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { upgradeAgent } from "@/actions/servers";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface AgentUpdateNudgeProps {
	serverId: string;
	currentVersion: string;
	latestVersion: string;
	serverStatus: "pending" | "online" | "offline" | "unknown";
	upgradeStatus: "idle" | "queued" | "upgrading" | "succeeded" | "failed";
	upgradeTargetVersion: string | null;
	upgradeError: string | null;
}

export function AgentUpdateNudge({
	serverId,
	currentVersion,
	latestVersion,
	serverStatus,
	upgradeStatus,
	upgradeTargetVersion,
	upgradeError,
}: AgentUpdateNudgeProps) {
	const [open, setOpen] = useState(false);
	const [isPending, startTransition] = useTransition();
	const router = useRouter();
	const isTargetUpgradeActive =
		upgradeTargetVersion === latestVersion &&
		(upgradeStatus === "queued" || upgradeStatus === "upgrading");
	const disabled =
		serverStatus !== "online" || isTargetUpgradeActive || isPending;

	const handleUpgrade = () => {
		startTransition(async () => {
			try {
				await upgradeAgent(serverId, latestVersion);
				toast.success("Agent upgrade queued");
				setOpen(false);
				router.refresh();
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to queue agent upgrade",
				);
			}
		});
	};

	return (
		<>
			<div className="mx-auto mt-2 max-w-5xl rounded-lg border border-amber-500/40 bg-amber-500/5 lg:mt-0 lg:rounded-t-none lg:border-t-0">
				<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
					<div className="flex items-center gap-2">
						<span className="size-2 rounded-full bg-amber-500" />
						<span className="text-sm font-medium">
							Agent update available:{" "}
							<span className="font-mono">{currentVersion}</span>
							{" → "}
							<span className="font-mono">{latestVersion}</span>
						</span>
					</div>
					<Button size="sm" onClick={() => setOpen(true)}>
						<ArrowUpCircle className="size-4" data-icon="inline-start" />
						Update
					</Button>
				</div>
			</div>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>Update Agent</DialogTitle>
						<DialogDescription>
							Queue an upgrade for this server from{" "}
							<span className="font-mono">{currentVersion}</span> to{" "}
							<span className="font-mono">{latestVersion}</span>.
						</DialogDescription>
					</DialogHeader>

					<div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
						The control plane will send a work item over the authenticated
						agent channel. The agent downloads the release binary, verifies
						its checksum, and restarts itself after installation.
					</div>

					{isTargetUpgradeActive && (
						<p className="text-sm text-muted-foreground">
							Upgrade is already {upgradeStatus} for this version.
						</p>
					)}
					{upgradeStatus === "failed" && upgradeError && (
						<p className="text-sm text-destructive">
							Last failure: {upgradeError}
						</p>
					)}
					{serverStatus !== "online" && (
						<p className="text-sm text-destructive">
							Server must be online before an upgrade can be queued.
						</p>
					)}

					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							Cancel
						</DialogClose>
						<Button onClick={handleUpgrade} disabled={disabled}>
							{isPending
								? "Queueing..."
								: isTargetUpgradeActive
									? "Upgrade queued"
									: "Queue upgrade"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
