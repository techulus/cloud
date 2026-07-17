"use client";

import { memo, useState } from "react";
import { updateServiceStartCommand } from "@/actions/projects";
import { ConfigSection } from "@/components/service/details/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServiceWithDetails as Service } from "@/db/types";

export const StartCommandSection = memo(function StartCommandSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);
	const [command, setCommand] = useState(service.startCommand || "");

	const hasStartCommand = !!service.startCommand;
	const hasChanges = command !== (service.startCommand || "");

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceStartCommand(service.id, command.trim() || null);
			onUpdate();
		} catch (error) {
			console.error("Failed to update start command:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async () => {
		setIsSaving(true);
		try {
			await updateServiceStartCommand(service.id, null);
			setCommand("");
			onUpdate();
		} catch (error) {
			console.error("Failed to remove start command:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<ConfigSection
			title="Start Command"
			summary={service.startCommand || "Default"}
			summaryMuted={!hasStartCommand}
		>
			<div className="space-y-4">
				<div className="space-y-2">
					<label htmlFor="start-command" className="text-sm font-medium">
						Command
					</label>
					<Input
						id="start-command"
						placeholder="npm run start"
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						className="font-mono"
					/>
					<p className="text-xs text-muted-foreground">
						Overrides the container's default command (e.g., npm run start)
					</p>
				</div>

				{(hasChanges || hasStartCommand) && (
					<div className="flex gap-2">
						{hasChanges && (
							<Button onClick={handleSave} disabled={isSaving} size="sm">
								{isSaving ? "Saving..." : "Save"}
							</Button>
						)}
						{hasStartCommand && (
							<Button
								variant="outline"
								onClick={handleRemove}
								disabled={isSaving}
								size="sm"
							>
								Remove
							</Button>
						)}
					</div>
				)}
			</div>
		</ConfigSection>
	);
});
