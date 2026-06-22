"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { restoreDeletedService } from "@/actions/projects";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import type { Service } from "@/db/types";

type DeletedService = Pick<
	Service,
	| "id"
	| "name"
	| "image"
	| "deletedAt"
	| "purgeAfter"
	| "deletionStatus"
	| "deletionError"
>;

function formatDate(value: Date | string | null) {
	if (!value) return "Unknown";
	return new Date(value).toLocaleString();
}

export function DeletedServicesPanel({
	services,
}: {
	services: DeletedService[];
}) {
	const router = useRouter();
	const [restoreId, setRestoreId] = useState<string | null>(null);
	const [openRestoreId, setOpenRestoreId] = useState<string | null>(null);

	const handleRestore = async (serviceId: string) => {
		setRestoreId(serviceId);
		setOpenRestoreId(null);
		try {
			await restoreDeletedService(serviceId);
			toast.success("Restore started");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to restore service",
			);
		} finally {
			setRestoreId(null);
		}
	};

	if (services.length === 0) {
		return (
			<Empty>
				<EmptyTitle>No deleted services</EmptyTitle>
				<EmptyDescription>
					Stateful services deleted from this environment will appear here until
					their retention window expires.
				</EmptyDescription>
			</Empty>
		);
	}

	return (
		<div className="divide-y rounded-lg border">
			{services.map((service) => {
				const restoreDisabled =
					restoreId === service.id ||
					(!!service.deletionStatus && service.deletionStatus !== "failed");
				const restoreLabel =
					restoreId === service.id || service.deletionStatus === "restoring"
						? "Restoring..."
						: "Restore";

				return (
					<div
						key={service.id}
						className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
					>
						<div className="min-w-0">
							<div className="flex items-center gap-2">
								<h2 className="truncate font-medium">{service.name}</h2>
								{service.deletionStatus && (
									<span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
										{service.deletionStatus}
									</span>
								)}
							</div>
							<p className="truncate text-sm text-muted-foreground">
								{service.image}
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Deleted {formatDate(service.deletedAt)}. Purges{" "}
								{formatDate(service.purgeAfter)}.
							</p>
							{service.deletionError && (
								<p className="mt-1 text-xs text-destructive">
									{service.deletionError}
								</p>
							)}
						</div>
						<AlertDialog
							open={openRestoreId === service.id}
							onOpenChange={(open) =>
								setOpenRestoreId(open ? service.id : null)
							}
						>
							<AlertDialogTrigger
								render={<Button variant="outline" disabled={restoreDisabled} />}
							>
								<RotateCcw className="h-4 w-4" />
								{restoreLabel}
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Restore {service.name}?</AlertDialogTitle>
									<AlertDialogDescription>
										This will recreate the service deployment and restore its
										retained volumes from the deletion backup.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => handleRestore(service.id)}
										disabled={restoreDisabled}
									>
										Restore
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
				);
			})}
		</div>
	);
}
