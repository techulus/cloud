"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteServer } from "@/actions/servers";
import { DeleteConfirmationDialog } from "@/components/core/delete-confirmation-dialog";
import type { DeleteConfirmation } from "@/lib/two-factor";

export function ServerDangerZone({
	serverId,
	serverName,
}: {
	serverId: string;
	serverName: string;
}) {
	const router = useRouter();

	const handleDelete = async (confirmation?: DeleteConfirmation) => {
		await deleteServer(serverId, confirmation);
		toast.success("Server deleted");
		router.push("/dashboard");
	};

	return (
		<div className="rounded-lg border border-destructive/50">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
				<div className="min-w-0">
					<p className="text-sm font-medium">Delete this server</p>
					<p className="text-sm text-muted-foreground">
						Once deleted, this server will be permanently removed and will no
						longer be available for deployments.
					</p>
				</div>
				<DeleteConfirmationDialog
					resourceName={serverName}
					triggerLabel="Delete Server"
					description="This action cannot be undone. This will permanently delete the server and remove it from your infrastructure."
					fallbackError="Failed to delete server"
					onDelete={handleDelete}
				/>
			</div>
		</div>
	);
}
