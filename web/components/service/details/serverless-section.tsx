"use client";

import { Moon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { updateServiceServerlessSettings } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import type { ServiceWithDetails as Service } from "@/db/types";

export const ServerlessSection = memo(function ServerlessSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);
	const [enabled, setEnabled] = useState(service.serverlessEnabled);
	const [sleepAfterSeconds, setSleepAfterSeconds] = useState(
		String(service.serverlessSleepAfterSeconds ?? 300),
	);
	const [wakeTimeoutSeconds, setWakeTimeoutSeconds] = useState(
		String(service.serverlessWakeTimeoutSeconds ?? 300),
	);
	const [minReadyReplicas, setMinReadyReplicas] = useState(
		String(service.serverlessMinReadyReplicas ?? 1),
	);

	const parsed = useMemo(
		() => ({
			sleepAfterSeconds: Number.parseInt(sleepAfterSeconds, 10),
			wakeTimeoutSeconds: Number.parseInt(wakeTimeoutSeconds, 10),
			minReadyReplicas: Number.parseInt(minReadyReplicas, 10),
		}),
		[sleepAfterSeconds, wakeTimeoutSeconds, minReadyReplicas],
	);

	const validationError = useMemo(() => {
		if (service.stateful && enabled) {
			return "Serverless is only supported for stateless services";
		}
		if (
			!Number.isInteger(parsed.sleepAfterSeconds) ||
			parsed.sleepAfterSeconds < 60 ||
			parsed.sleepAfterSeconds > 86_400
		) {
			return "Sleep timeout must be between 60 seconds and 24 hours";
		}
		if (
			!Number.isInteger(parsed.wakeTimeoutSeconds) ||
			parsed.wakeTimeoutSeconds < 10 ||
			parsed.wakeTimeoutSeconds > 900
		) {
			return "Wake timeout must be between 10 and 900 seconds";
		}
		if (
			!Number.isInteger(parsed.minReadyReplicas) ||
			parsed.minReadyReplicas < 1 ||
			parsed.minReadyReplicas > 10
		) {
			return "Minimum ready replicas must be between 1 and 10";
		}
		return null;
	}, [enabled, parsed, service.stateful]);

	const hasChanges =
		enabled !== service.serverlessEnabled ||
		parsed.sleepAfterSeconds !== service.serverlessSleepAfterSeconds ||
		parsed.wakeTimeoutSeconds !== service.serverlessWakeTimeoutSeconds ||
		parsed.minReadyReplicas !== service.serverlessMinReadyReplicas;

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceServerlessSettings(service.id, {
				enabled,
				sleepAfterSeconds: parsed.sleepAfterSeconds,
				wakeTimeoutSeconds: parsed.wakeTimeoutSeconds,
				minReadyReplicas: parsed.minReadyReplicas,
			});
			onUpdate();
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Moon
						className={`size-5 ${enabled ? "text-blue-500" : "text-muted-foreground"}`}
					/>
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Serverless</ItemTitle>
				</ItemContent>
				<Switch
					checked={enabled}
					onCheckedChange={setEnabled}
					disabled={service.stateful || isSaving}
				/>
			</Item>
			<div className="space-y-4 p-4">
				<div className="grid gap-3 md:grid-cols-3">
					<div className="space-y-1">
						<label
							htmlFor="serverless-sleep-after"
							className="text-xs font-medium"
						>
							Sleep After (s)
						</label>
						<Input
							id="serverless-sleep-after"
							type="number"
							min="60"
							max="86400"
							step="30"
							value={sleepAfterSeconds}
							onChange={(event) => setSleepAfterSeconds(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<label
							htmlFor="serverless-wake-timeout"
							className="text-xs font-medium"
						>
							Wake Timeout (s)
						</label>
						<Input
							id="serverless-wake-timeout"
							type="number"
							min="10"
							max="900"
							step="10"
							value={wakeTimeoutSeconds}
							onChange={(event) => setWakeTimeoutSeconds(event.target.value)}
						/>
					</div>
					<div className="space-y-1">
						<label
							htmlFor="serverless-min-ready"
							className="text-xs font-medium"
						>
							Min Ready
						</label>
						<Input
							id="serverless-min-ready"
							type="number"
							min="1"
							max="10"
							step="1"
							value={minReadyReplicas}
							onChange={(event) => setMinReadyReplicas(event.target.value)}
						/>
					</div>
				</div>

				{validationError && (
					<p className="text-xs text-destructive">{validationError}</p>
				)}

				{hasChanges && (
					<Button
						onClick={handleSave}
						disabled={isSaving || !!validationError}
						size="sm"
					>
						{isSaving ? "Saving..." : "Save"}
					</Button>
				)}
			</div>
		</div>
	);
});
