"use client";

import cronstrue from "cronstrue";
import { memo, useMemo, useState } from "react";
import { updateServiceSchedule } from "@/actions/projects";
import { ConfigSection } from "@/components/service/details/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ServiceWithDetails as Service } from "@/db/types";

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
			return {
				description: cronstrue.toString(schedule, { verbose: true }),
				error: null,
			};
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
		<ConfigSection
			title="Deployment Schedule"
			summary={service.deploymentSchedule || "None"}
			summaryMuted={!hasSchedule}
		>
			<div className="space-y-4">
				<div className="space-y-2">
					<label htmlFor="deployment-schedule" className="text-sm font-medium">
						Cron Expression
					</label>
					<Input
						id="deployment-schedule"
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
		</ConfigSection>
	);
});
