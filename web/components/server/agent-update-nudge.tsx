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
			<button
				type="button"
				className="flex items-center gap-2 rounded-lg border border-amber-500/50 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400 hover:bg-amber-500/10 transition-colors w-full"
				onClick={() => setOpen(true)}
			>
				<ArrowUpCircle className="size-4 shrink-0" />
				<span>
					Agent update available:{" "}
					<span className="font-mono">{currentVersion}</span>
					{" → "}
					<span className="font-mono">{latestVersion}</span>
				</span>
			</button>

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
						The control plane will send a signed work item to the agent. The
						agent downloads the release binary, verifies its checksum, and
						restarts itself after installation.
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
