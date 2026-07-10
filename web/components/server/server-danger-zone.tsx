"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deleteServer } from "@/actions/servers";
import { DeleteConfirmationDialog } from "@/components/core/delete-confirmation-dialog";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
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
		<div className="space-y-3">
			<h2 className="text-xl font-semibold text-destructive">Danger Zone</h2>
			<div className="rounded-lg border border-destructive/50">
				<Item className="border-0">
					<ItemMedia variant="icon">
						<Trash2 className="size-5 text-destructive" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Delete this server</ItemTitle>
						<p className="text-sm text-muted-foreground">
							Once deleted, this server will be permanently removed and will no
							longer be available for deployments.
						</p>
					</ItemContent>
					<DeleteConfirmationDialog
						resourceName={serverName}
						triggerLabel="Delete Server"
						description="This action cannot be undone. This will permanently delete the server and remove it from your infrastructure."
						fallbackError="Failed to delete server"
						onDelete={handleDelete}
					/>
				</Item>
			</div>
		</div>
	);
}
