"use client";

import { Loader2, Terminal, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import useSWRInfinite from "swr/infinite";
import { useService } from "@/components/service/service-layout-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatRelativeTime } from "@/lib/date";
import { isObservedReady } from "@/lib/deployment-status";
import { fetcher } from "@/lib/fetcher";

type CommandStatus =
	| "pending"
	| "running"
	| "succeeded"
	| "failed"
	| "timed_out";

type CommandRun = {
	id: string;
	command: string;
	status: CommandStatus;
	output: string | null;
	exitCode: number | null;
	outputTruncated: boolean;
	errorMessage: string | null;
	actor: { name: string };
	serverName: string;
	containerId: string;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
};

type CommandHistory = {
	commands: CommandRun[];
	nextCursor: string | null;
};

const STATUS_LABELS: Record<CommandStatus, string> = {
	pending: "Queued",
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
	timed_out: "Timed out",
};

function CommandStatusBadge({ command }: { command: CommandRun }) {
	const failed = command.status === "failed" || command.status === "timed_out";
	return (
		<Badge
			variant={failed ? "destructive" : "secondary"}
			className={
				command.status === "succeeded" ? "text-emerald-700" : undefined
			}
		>
			{STATUS_LABELS[command.status]}
			{command.exitCode !== null ? ` · exit ${command.exitCode}` : null}
		</Badge>
	);
}

export default function CommandsPage() {
	const { service } = useService();
	const targets = service.deployments.filter(
		(deployment) =>
			deployment.containerId &&
			deployment.runtimeDesiredState === "running" &&
			isObservedReady(deployment.observedPhase) &&
			deployment.server?.status === "online",
	);
	const [deploymentId, setDeploymentId] = useState(targets[0]?.id ?? "");
	const selectedDeploymentId = targets.some(
		(target) => target.id === deploymentId,
	)
		? deploymentId
		: (targets[0]?.id ?? "");
	const [command, setCommand] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	const {
		data,
		error: historyError,
		isLoading,
		isValidating,
		mutate,
		size,
		setSize,
	} = useSWRInfinite<CommandHistory>(
		(pageIndex, previousPage) => {
			if (previousPage && !previousPage.nextCursor) return null;
			const cursor = pageIndex === 0 ? null : previousPage?.nextCursor;
			return `/api/services/${service.id}/commands${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
		},
		fetcher,
		{
			refreshInterval: (pages) =>
				pages?.some((page) =>
					page.commands.some(
						(item) => item.status === "pending" || item.status === "running",
					),
				)
					? 2000
					: 0,
			revalidateOnFocus: true,
		},
	);

	const history = useMemo(() => {
		const byId = new Map<string, CommandRun>();
		for (const page of data ?? []) {
			for (const item of page.commands) byId.set(item.id, item);
		}
		return [...byId.values()];
	}, [data]);
	const hasMore = data?.[data.length - 1]?.nextCursor != null;
	const isLoadingMore = isValidating && Boolean(data?.[size - 1] === undefined);

	async function runCommand() {
		setSubmitting(true);
		setSubmitError(null);
		try {
			const response = await fetch(`/api/services/${service.id}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					deploymentId: selectedDeploymentId,
					command,
				}),
			});
			if (!response.ok) {
				const body = (await response.json()) as {
					error?: string;
					message?: string;
				};
				throw new Error(
					body.error ?? body.message ?? "Command could not be queued",
				);
			}
			setCommand("");
			await mutate();
		} catch (error) {
			setSubmitError(
				error instanceof Error ? error.message : "Command could not be queued",
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-6">
			<Card>
				<CardHeader>
					<CardTitle>Run command</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{targets.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No ready, running container is available on an online server.
						</p>
					) : (
						<NativeSelect
							aria-label="Target container"
							value={selectedDeploymentId}
							onChange={(event) => setDeploymentId(event.target.value)}
						>
							{targets.map((target) => (
								<NativeSelectOption key={target.id} value={target.id}>
									{target.server?.name} · {target.containerId?.slice(0, 12)}
								</NativeSelectOption>
							))}
						</NativeSelect>
					)}
					<Textarea
						aria-label="Command"
						className="font-mono"
						value={command}
						onChange={(event) => setCommand(event.target.value)}
						maxLength={4096}
						rows={4}
						placeholder="e.g. ls -la"
						disabled={targets.length === 0 || submitting}
					/>
					<div className="flex items-center justify-between gap-4">
						<span className="text-xs text-muted-foreground">
							{command.length}/4096 · 60 second timeout
						</span>
						<Button
							onClick={() => void runCommand()}
							disabled={!selectedDeploymentId || !command.trim() || submitting}
						>
							{submitting ? <Loader2 className="animate-spin" /> : null}
							{submitting ? "Queuing…" : "Run"}
						</Button>
					</div>
					{submitError ? (
						<p className="text-sm text-destructive">{submitError}</p>
					) : null}
				</CardContent>
			</Card>

			<section className="space-y-3">
				<h2 className="text-lg font-semibold">Command history</h2>
				{isLoading ? (
					<p className="text-sm text-muted-foreground">Loading history…</p>
				) : historyError ? (
					<Empty className="border py-12">
						<EmptyMedia variant="icon">
							<XCircle />
						</EmptyMedia>
						<EmptyTitle>Unable to load command history</EmptyTitle>
						<EmptyDescription>
							Command history is unavailable or you do not have permission to
							view it.
						</EmptyDescription>
						<Button variant="outline" onClick={() => void mutate()}>
							Retry
						</Button>
					</Empty>
				) : history.length === 0 ? (
					<Empty className="border py-12">
						<EmptyMedia variant="icon">
							<Terminal />
						</EmptyMedia>
						<EmptyTitle>No commands yet</EmptyTitle>
						<EmptyDescription>
							Run a command to see its output and execution details here.
						</EmptyDescription>
					</Empty>
				) : (
					<div className="space-y-3">
						{history.map((item) => (
							<Card key={item.id}>
								<CardContent className="space-y-3 pt-6">
									<div className="flex items-start justify-between gap-4">
										<code className="break-all text-sm">$ {item.command}</code>
										<CommandStatusBadge command={item} />
									</div>
									<p className="text-xs text-muted-foreground">
										{item.actor.name} · {item.serverName} ·{" "}
										{item.containerId.slice(0, 12)} ·{" "}
										<time title={formatDateTime(item.createdAt)}>
											{formatRelativeTime(item.createdAt)}
										</time>
									</p>
									{item.startedAt || item.completedAt ? (
										<p className="text-xs text-muted-foreground">
											{item.startedAt
												? `Started ${formatDateTime(item.startedAt)}`
												: null}
											{item.startedAt && item.completedAt ? " · " : null}
											{item.completedAt
												? `Completed ${formatDateTime(item.completedAt)}`
												: null}
										</p>
									) : null}
									{item.output || item.errorMessage ? (
										<details open>
											<summary className="cursor-pointer text-sm">
												Combined output
											</summary>
											<pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
												{item.output}
												{item.errorMessage
													? `${item.output ? "\n" : ""}${item.errorMessage}`
													: null}
											</pre>
											{item.outputTruncated ? (
												<p className="mt-1 text-xs text-amber-600">
													Output was truncated at 64 KiB.
												</p>
											) : null}
										</details>
									) : null}
								</CardContent>
							</Card>
						))}
					</div>
				)}

				{hasMore ? (
					<div className="flex justify-center pt-2">
						<Button
							variant="outline"
							disabled={isLoadingMore}
							onClick={() => void setSize(size + 1)}
						>
							{isLoadingMore ? <Loader2 className="animate-spin" /> : null}
							Load older commands
						</Button>
					</div>
				) : null}
			</section>
		</div>
	);
}
