"use client";

import { Moon } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { toast } from "sonner";
import { updateServiceServerlessSettings } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";
import type { ServiceWithDetails as Service } from "@/db/types";
import { MIN_SERVERLESS_SLEEP_AFTER_SECONDS } from "@/lib/service-config";

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
	const hasPublicHttpEndpoint = useMemo(
		() =>
			service.ports.some(
				(port) => port.isPublic && port.protocol === "http" && !!port.domain,
			),
		[service.ports],
	);
	const unavailableReason = !hasPublicHttpEndpoint
		? "Add a public HTTP port with a domain to enable serverless"
		: null;
	const optionsDisabled = !!unavailableReason || isSaving;

	const parsed = useMemo(
		() => ({
			sleepAfterSeconds: Number.parseInt(sleepAfterSeconds, 10),
			wakeTimeoutSeconds: Number.parseInt(wakeTimeoutSeconds, 10),
		}),
		[sleepAfterSeconds, wakeTimeoutSeconds],
	);

	const validationError = useMemo(() => {
		if (unavailableReason && enabled) {
			return unavailableReason;
		}
		if (
			!Number.isInteger(parsed.sleepAfterSeconds) ||
			parsed.sleepAfterSeconds < MIN_SERVERLESS_SLEEP_AFTER_SECONDS ||
			parsed.sleepAfterSeconds > 86_400
		) {
			return `Sleep timeout must be between ${MIN_SERVERLESS_SLEEP_AFTER_SECONDS} seconds and 24 hours`;
		}
		if (
			!Number.isInteger(parsed.wakeTimeoutSeconds) ||
			parsed.wakeTimeoutSeconds < 10 ||
			parsed.wakeTimeoutSeconds > 900
		) {
			return "Wake timeout must be between 10 and 900 seconds";
		}
		return null;
	}, [enabled, parsed, unavailableReason]);

	const hasChanges =
		enabled !== service.serverlessEnabled ||
		parsed.sleepAfterSeconds !== service.serverlessSleepAfterSeconds ||
		parsed.wakeTimeoutSeconds !== service.serverlessWakeTimeoutSeconds;

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceServerlessSettings(service.id, {
				enabled,
				sleepAfterSeconds: parsed.sleepAfterSeconds,
				wakeTimeoutSeconds: parsed.wakeTimeoutSeconds,
			});
			onUpdate();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update serverless settings",
			);
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
					disabled={(!!unavailableReason && !enabled) || isSaving}
				/>
			</Item>
			<div className="space-y-4 p-4">
				<div className="grid gap-3 md:grid-cols-2">
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
							min={MIN_SERVERLESS_SLEEP_AFTER_SECONDS}
							max="86400"
							step="30"
							value={sleepAfterSeconds}
							disabled={optionsDisabled}
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
							disabled={optionsDisabled}
							onChange={(event) => setWakeTimeoutSeconds(event.target.value)}
						/>
					</div>
				</div>

				<p className="text-sm text-muted-foreground">
					Containers scale down to zero when idle and wake on traffic. Requests
					while sleeping are queued and served after the container is ready.
				</p>

				{unavailableReason && !enabled && (
					<p className="text-xs text-muted-foreground">{unavailableReason}.</p>
				)}

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
