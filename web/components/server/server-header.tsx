"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateServerName } from "@/actions/servers";
import { EditableText } from "@/components/editable-text";
import { StatusIndicator } from "@/components/core/status-indicator";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/date";

type ServerHeaderProps = {
	server: {
		id: string;
		name: string;
		status: "pending" | "online" | "offline" | "unknown";
		isProxy: boolean;
		lastHeartbeat: Date | null;
	};
};

export function ServerHeader({ server }: ServerHeaderProps) {
	const router = useRouter();

	const handleUpdateName = async (newName: string) => {
		try {
			await updateServerName(server.id, newName);
			toast.success("Server name updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update name",
			);
			throw error;
		}
	};

	return (
		<div className="flex items-center gap-3">
			<EditableText
				value={server.name}
				onChange={handleUpdateName}
				label="Server Name"
				textClassName="text-lg font-semibold"
			/>
			<span className="text-sm text-muted-foreground">
				({server.lastHeartbeat ? formatRelativeTime(server.lastHeartbeat) : "Never seen"})
			</span>
			<StatusIndicator status={server.status} />
			{server.isProxy && <Badge variant="secondary">Proxy</Badge>}
		</div>
	);
}
