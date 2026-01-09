"use client";

import { useState, useMemo, memo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Clock } from "lucide-react";
import { updateServiceSchedule } from "@/actions/projects";
import type { ServiceWithDetails as Service } from "@/db/types";
import cronstrue from "cronstrue";

export const ScheduleSection = memo(function ScheduleSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [schedule, setSchedule] = useState(service.deploymentSchedule || "");

	const hasSchedule = !!service.deploymentSchedule;

	const hasChanges = useMemo(() => {
		const original = service.deploymentSchedule || "";
		return schedule !== original;
	}, [service.deploymentSchedule, schedule]);

	const { description, error } = useMemo(() => {
		if (!schedule.trim()) {
			return { description: null, error: null };
		}
		try {
			return { description: cronstrue.toString(schedule), error: null };
		} catch {
			return { description: null, error: "Invalid cron expression" };
		}
	}, [schedule]);

	const handleSave = async () => {
		if (error) return;
		setIsSaving(true);
		setSaveError(null);
		try {
			await updateServiceSchedule(service.id, schedule.trim() || null);
			onUpdate();
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : "Failed to save");
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async () => {
		setIsSaving(true);
		setSaveError(null);
		try {
			await updateServiceSchedule(service.id, null);
			setSchedule("");
			onUpdate();
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : "Failed to remove");
		} finally {
			setIsSaving(false);
		}
	};

	const handleReset = () => {
		setSchedule(service.deploymentSchedule || "");
		setSaveError(null);
	};

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Clock
						className={`size-5 ${hasSchedule ? "text-blue-500" : "text-muted-foreground"}`}
					/>
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Deployment Schedule</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				<div className="space-y-2">
					<label className="text-sm font-medium">Cron Expression</label>
					<Input
						placeholder="0 2 * * * (daily at 2am)"
						value={schedule}
						onChange={(e) => setSchedule(e.target.value)}
					/>
					{(error || saveError) && (
						<p className="text-xs text-destructive">{error || saveError}</p>
					)}
					{!error && !saveError && description && (
						<p className="text-xs text-muted-foreground">{description}</p>
					)}
					<p className="text-xs text-muted-foreground">
						{service.sourceType === "github"
							? "Triggers a build and deploy on schedule"
							: "Redeploys the current image on schedule"}
					</p>
				</div>

				{(hasChanges || hasSchedule) && (
					<div className="flex gap-2">
						{hasChanges && !error && (
							<Button onClick={handleSave} disabled={isSaving} size="sm">
								{isSaving ? "Saving..." : "Save"}
							</Button>
						)}
						{hasChanges && (
							<Button
								variant="outline"
								onClick={handleReset}
								disabled={isSaving}
								size="sm"
							>
								Cancel
							</Button>
						)}
						{hasSchedule && !hasChanges && (
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
		</div>
	);
});
