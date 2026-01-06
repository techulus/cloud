"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { deleteServer } from "@/actions/servers";
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
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";

export function ServerDangerZone({
	serverId,
	serverName,
}: {
	serverId: string;
	serverName: string;
}) {
	const router = useRouter();
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await deleteServer(serverId);
			toast.success("Server deleted");
			router.push("/dashboard");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete server",
			);
			setIsDeleting(false);
		}
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
					<AlertDialog>
						<AlertDialogTrigger render={<Button variant="destructive" />}>
							Delete Server
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>Delete {serverName}?</AlertDialogTitle>
								<AlertDialogDescription>
									This action cannot be undone. This will permanently delete the
									server and remove it from your infrastructure.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									variant="destructive"
									onClick={handleDelete}
									disabled={isDeleting}
								>
									{isDeleting ? "Deleting..." : "Delete"}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</Item>
			</div>
		</div>
	);
}
