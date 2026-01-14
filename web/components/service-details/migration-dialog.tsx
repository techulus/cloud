"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	DialogClose,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { ArrowRightLeft, Loader2, AlertTriangle } from "lucide-react";
import { startMigration, getMigrationStatus, cancelMigration } from "@/actions/migrations";
import type { ServiceWithDetails as Service, Server } from "@/db/types";

type MigrationDialogProps = {
	service: Service;
	servers: Pick<Server, "id" | "name" | "status">[];
	onMigrationComplete: () => void;
};

export function MigrationDialog({
	service,
	servers,
	onMigrationComplete,
}: MigrationDialogProps) {
	const [open, setOpen] = useState(false);
	const [targetServerId, setTargetServerId] = useState<string>("");
	const [migrating, setMigrating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [migrationStatus, setMigrationStatus] = useState<string | null>(
		service.migrationStatus ?? null,
	);
	const [migrationError, setMigrationError] = useState<string | null>(
		service.migrationError ?? null,
	);

	const currentServerId = service.lockedServerId;
	const availableServers = servers.filter(
		(s) => s.id !== currentServerId && s.status === "online",
	);

	useEffect(() => {
		if (!migrationStatus) return;

		const interval = setInterval(async () => {
			const status = await getMigrationStatus(service.id);
			if (status) {
				setMigrationStatus(status.migrationStatus);
				setMigrationError(status.migrationError);
				if (!status.migrationStatus) {
					onMigrationComplete();
					clearInterval(interval);
				}
			}
		}, 3000);

		return () => clearInterval(interval);
	}, [migrationStatus, service.id, onMigrationComplete]);

	const handleStartMigration = async () => {
		if (!targetServerId) return;

		setMigrating(true);
		setError(null);

		try {
			await startMigration(service.id, targetServerId);
			setMigrationStatus("stopping");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start migration");
		} finally {
			setMigrating(false);
		}
	};

	const handleCancelMigration = async () => {
		try {
			await cancelMigration(service.id);
			setMigrationStatus(null);
			setMigrationError(null);
			onMigrationComplete();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to cancel migration");
		}
	};

	const getStatusText = (status: string) => {
		switch (status) {
			case "stopping":
				return "Stopping service...";
			case "backing_up":
				return "Creating backup...";
			case "restoring":
				return "Restoring to new server...";
			case "starting":
				return "Starting service on new server...";
			case "failed":
				return "Migration failed";
			default:
				return status;
		}
	};

	if (migrationStatus) {
		return (
			<div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4 space-y-3">
				<div className="flex items-center gap-2">
					{migrationStatus === "failed" ? (
						<AlertTriangle className="h-5 w-5 text-yellow-500" />
					) : (
						<Loader2 className="h-5 w-5 animate-spin text-yellow-500" />
					)}
					<span className="font-medium">{getStatusText(migrationStatus)}</span>
				</div>

				{migrationError && (
					<p className="text-sm text-red-600 dark:text-red-400">
						{migrationError}
					</p>
				)}

				{migrationStatus === "failed" && (
					<Button variant="outline" size="sm" onClick={handleCancelMigration}>
						Clear Migration State
					</Button>
				)}
			</div>
		);
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				<ArrowRightLeft className="h-4 w-4 mr-2" />
				Migrate to Another Server
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Migrate Service</DialogTitle>
					<DialogDescription>
						Move this stateful service to another server. This will:
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<ul className="text-sm space-y-1 list-disc list-inside text-muted-foreground">
						<li>Stop the service on the current server</li>
						<li>Create a backup of all volumes</li>
						<li>Restore the backup on the target server</li>
						<li>Start the service on the new server</li>
					</ul>

					<div className="p-3 bg-yellow-500/10 border border-yellow-500/50 rounded-md">
						<p className="text-sm text-yellow-600 dark:text-yellow-400">
							<AlertTriangle className="h-4 w-4 inline mr-1" />
							The service will experience downtime during migration.
						</p>
					</div>

					{availableServers.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No other online servers available for migration.
						</p>
					) : (
						<div className="space-y-2">
							<label className="text-sm font-medium">Target Server</label>
							<Select value={targetServerId} onValueChange={(v) => v && setTargetServerId(v)}>
								<SelectTrigger className="w-full">
									<SelectValue>{targetServerId ? servers.find(s => s.id === targetServerId)?.name : "Select a server"}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{availableServers.map((server) => (
										<SelectItem key={server.id} value={server.id}>
											{server.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					)}

					{error && (
						<p className="text-sm text-red-600 dark:text-red-400">{error}</p>
					)}
				</div>

				<DialogFooter showCloseButton>
					<Button
						onClick={handleStartMigration}
						disabled={!targetServerId || migrating}
					>
						{migrating ? (
							<>
								<Loader2 className="h-4 w-4 mr-2 animate-spin" />
								Starting...
							</>
						) : (
							"Start Migration"
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
