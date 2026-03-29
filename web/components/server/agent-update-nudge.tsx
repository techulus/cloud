"use client";

import { useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface AgentUpdateNudgeProps {
	currentVersion: string;
	latestVersion: string;
	appUrl: string;
}

export function AgentUpdateNudge({
	currentVersion,
	latestVersion,
	appUrl,
}: AgentUpdateNudgeProps) {
	const [open, setOpen] = useState(false);

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
							Run the following command on your server to update the agent from{" "}
							<span className="font-mono">{currentVersion}</span> to{" "}
							<span className="font-mono">{latestVersion}</span>.
						</DialogDescription>
					</DialogHeader>

					<code className="block rounded-lg bg-muted p-3 text-sm font-mono break-all">
						sudo bash -c &quot;$(curl -fsSL {appUrl}/update.sh)&quot;
					</code>

					<DialogFooter showCloseButton />
				</DialogContent>
			</Dialog>
		</>
	);
}
