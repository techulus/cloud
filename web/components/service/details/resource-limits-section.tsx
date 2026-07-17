"use client";

import { memo, useMemo, useState } from "react";
import { updateServiceResourceLimits } from "@/actions/projects";
import { ConfigSection } from "@/components/service/details/config-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import type { ServiceWithDetails as Service } from "@/db/types";

type Preset = {
	label: string;
	cpuCores: number | null;
	memoryMb: number | null;
};

const PRESETS: Record<string, Preset> = {
	none: { label: "No limit", cpuCores: null, memoryMb: null },
	small: { label: "Small (0.5 CPU, 256MB)", cpuCores: 0.5, memoryMb: 256 },
	medium: { label: "Medium (1 CPU, 512MB)", cpuCores: 1, memoryMb: 512 },
	large: {
		label: "Large (2 CPU, 1024MB)",
		cpuCores: 2,
		memoryMb: 1024,
	},
	xlarge: { label: "X-Large (4 CPU, 2048MB)", cpuCores: 4, memoryMb: 2048 },
	custom: { label: "Custom", cpuCores: null, memoryMb: null },
};

function getPresetFromValues(
	cpuCores: number | null,
	memoryMb: number | null,
): string {
	if (cpuCores === null && memoryMb === null) return "none";
	if (cpuCores === 0.5 && memoryMb === 256) return "small";
	if (cpuCores === 1 && memoryMb === 512) return "medium";
	if (cpuCores === 2 && memoryMb === 1024) return "large";
	if (cpuCores === 4 && memoryMb === 2048) return "xlarge";
	return "custom";
}

export const ResourceLimitsSection = memo(function ResourceLimitsSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);

	const initialPreset = getPresetFromValues(
		service.resourceCpuLimit,
		service.resourceMemoryLimitMb,
	);
	const [selectedPreset, setSelectedPreset] = useState(initialPreset);
	const [customCpu, setCustomCpu] = useState(
		service.resourceCpuLimit?.toString() || "",
	);
	const [customMemory, setCustomMemory] = useState(
		service.resourceMemoryLimitMb?.toString() || "",
	);

	const currentValues = useMemo(() => {
		if (selectedPreset === "custom") {
			return {
				cpuCores: customCpu ? parseFloat(customCpu) : null,
				memoryMb: customMemory ? parseInt(customMemory, 10) : null,
			};
		}
		return PRESETS[selectedPreset];
	}, [selectedPreset, customCpu, customMemory]);

	const validationError = useMemo(() => {
		if (selectedPreset !== "custom") return null;

		const cpu = currentValues.cpuCores;
		const mem = currentValues.memoryMb;

		if (cpu !== null && (cpu < 0.1 || cpu > 64)) {
			return "CPU must be between 0.1 and 64 cores";
		}
		if (mem !== null && (mem < 64 || mem > 65536)) {
			return "Memory must be between 64 MB and 64 GB";
		}
		if ((cpu !== null && mem === null) || (cpu === null && mem !== null)) {
			return "Both CPU and memory must be set together";
		}
		return null;
	}, [selectedPreset, currentValues]);

	const hasChanges = useMemo(() => {
		const originalCpu = service.resourceCpuLimit;
		const originalMemory = service.resourceMemoryLimitMb;
		return (
			currentValues.cpuCores !== originalCpu ||
			currentValues.memoryMb !== originalMemory
		);
	}, [service, currentValues]);

	const hasLimits =
		service.resourceCpuLimit !== null || service.resourceMemoryLimitMb !== null;

	const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const preset = e.target.value;
		setSelectedPreset(preset);
		if (preset !== "custom" && preset !== "none") {
			const p = PRESETS[preset];
			setCustomCpu(p.cpuCores?.toString() || "");
			setCustomMemory(p.memoryMb?.toString() || "");
		}
	};

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceResourceLimits(service.id, {
				cpuCores: currentValues.cpuCores,
				memoryMb: currentValues.memoryMb,
			});
			onUpdate();
		} catch (error) {
			console.error("Failed to update resource limits:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async () => {
		setIsSaving(true);
		try {
			await updateServiceResourceLimits(service.id, {
				cpuCores: null,
				memoryMb: null,
			});
			setSelectedPreset("none");
			setCustomCpu("");
			setCustomMemory("");
			onUpdate();
		} catch (error) {
			console.error("Failed to remove resource limits:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<ConfigSection
			title="Resource Limits"
			summary={
				hasLimits
					? `${service.resourceCpuLimit ?? "?"} CPU · ${service.resourceMemoryLimitMb ?? "?"} MB`
					: "No limit"
			}
			summaryMuted={!hasLimits}
		>
			<div className="space-y-4">
				<div className="space-y-2">
					<label
						htmlFor="resource-limits-preset"
						className="text-sm font-medium"
					>
						Preset
					</label>
					<NativeSelect
						id="resource-limits-preset"
						value={selectedPreset}
						onChange={handlePresetChange}
						className="w-full"
					>
						{Object.entries(PRESETS).map(([key, preset]) => (
							<NativeSelectOption key={key} value={key}>
								{preset.label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</div>

				{selectedPreset === "custom" && (
					<div className="space-y-3">
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1">
								<label
									htmlFor="resource-cpu-cores"
									className="text-xs font-medium"
								>
									CPU Cores
								</label>
								<Input
									id="resource-cpu-cores"
									type="number"
									step="0.1"
									min="0.1"
									max="64"
									placeholder="e.g. 0.5"
									value={customCpu}
									onChange={(e) => setCustomCpu(e.target.value)}
								/>
							</div>
							<div className="space-y-1">
								<label
									htmlFor="resource-memory-mb"
									className="text-xs font-medium"
								>
									Memory (MB)
								</label>
								<Input
									id="resource-memory-mb"
									type="number"
									step="64"
									min="64"
									max="65536"
									placeholder="e.g. 256"
									value={customMemory}
									onChange={(e) => setCustomMemory(e.target.value)}
								/>
							</div>
						</div>
						{validationError && (
							<p className="text-xs text-destructive">{validationError}</p>
						)}
					</div>
				)}

				{selectedPreset !== "none" && selectedPreset !== "custom" && (
					<p className="text-xs text-muted-foreground">
						CPU: {PRESETS[selectedPreset].cpuCores} cores, Memory:{" "}
						{PRESETS[selectedPreset].memoryMb} MB
					</p>
				)}

				{(hasChanges || hasLimits) && (
					<div className="flex gap-2">
						{hasChanges && (
							<Button
								onClick={handleSave}
								disabled={isSaving || !!validationError}
								size="sm"
							>
								{isSaving ? "Saving..." : "Save"}
							</Button>
						)}
						{hasLimits && (
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
