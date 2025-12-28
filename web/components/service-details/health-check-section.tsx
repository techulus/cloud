"use client";

import { useState, useReducer, useMemo, memo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HeartPulse, ChevronDown } from "lucide-react";
import { updateServiceHealthCheck } from "@/actions/projects";
import type { Service } from "./types";

type HealthCheckState = {
	cmd: string;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

type HealthCheckAction =
	| { type: "SET_CMD"; payload: string }
	| { type: "SET_INTERVAL"; payload: number }
	| { type: "SET_TIMEOUT"; payload: number }
	| { type: "SET_RETRIES"; payload: number }
	| { type: "SET_START_PERIOD"; payload: number }
	| { type: "RESET"; payload: HealthCheckState };

function healthCheckReducer(
	state: HealthCheckState,
	action: HealthCheckAction,
): HealthCheckState {
	switch (action.type) {
		case "SET_CMD":
			return { ...state, cmd: action.payload };
		case "SET_INTERVAL":
			return { ...state, interval: action.payload };
		case "SET_TIMEOUT":
			return { ...state, timeout: action.payload };
		case "SET_RETRIES":
			return { ...state, retries: action.payload };
		case "SET_START_PERIOD":
			return { ...state, startPeriod: action.payload };
		case "RESET":
			return action.payload;
		default:
			return state;
	}
}

function getInitialHealthCheckState(service: Service): HealthCheckState {
	return {
		cmd: service.healthCheckCmd || "",
		interval: service.healthCheckInterval ?? 10,
		timeout: service.healthCheckTimeout ?? 5,
		retries: service.healthCheckRetries ?? 3,
		startPeriod: service.healthCheckStartPeriod ?? 30,
	};
}

export const HealthCheckSection = memo(function HealthCheckSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const [isSaving, setIsSaving] = useState(false);
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [state, dispatch] = useReducer(
		healthCheckReducer,
		service,
		getInitialHealthCheckState,
	);

	const hasHealthCheck = !!service.healthCheckCmd;

	const hasChanges = useMemo(() => {
		const originalCmd = service.healthCheckCmd || "";
		const originalInterval = service.healthCheckInterval ?? 10;
		const originalTimeout = service.healthCheckTimeout ?? 5;
		const originalRetries = service.healthCheckRetries ?? 3;
		const originalStartPeriod = service.healthCheckStartPeriod ?? 30;

		return (
			state.cmd !== originalCmd ||
			state.interval !== originalInterval ||
			state.timeout !== originalTimeout ||
			state.retries !== originalRetries ||
			state.startPeriod !== originalStartPeriod
		);
	}, [service, state]);

	const handleSave = async () => {
		setIsSaving(true);
		try {
			await updateServiceHealthCheck(service.id, {
				cmd: state.cmd.trim() || null,
				interval: state.interval,
				timeout: state.timeout,
				retries: state.retries,
				startPeriod: state.startPeriod,
			});
			onUpdate();
		} catch (error) {
			console.error("Failed to update health check:", error);
		} finally {
			setIsSaving(false);
		}
	};

	const handleRemove = async () => {
		setIsSaving(true);
		try {
			await updateServiceHealthCheck(service.id, {
				cmd: null,
				interval: 10,
				timeout: 5,
				retries: 3,
				startPeriod: 30,
			});
			onUpdate();
		} catch (error) {
			console.error("Failed to remove health check:", error);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<HeartPulse
						className={`h-4 w-4 ${hasHealthCheck ? "text-green-500" : ""}`}
					/>
					Health Check
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="space-y-2">
					<label className="text-sm font-medium">Command</label>
					<Input
						placeholder="curl -f http://localhost:8080/health || exit 1"
						value={state.cmd}
						onChange={(e) =>
							dispatch({ type: "SET_CMD", payload: e.target.value })
						}
					/>
					<p className="text-xs text-muted-foreground">
						Exit 0 = healthy, non-zero = unhealthy
					</p>
				</div>

				<button
					type="button"
					onClick={() => setShowAdvanced(!showAdvanced)}
					className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
				>
					<ChevronDown
						className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
					/>
					Advanced settings
				</button>

				{showAdvanced && (
					<div className="grid grid-cols-2 gap-3 pt-2">
						<div className="space-y-1">
							<label className="text-xs font-medium">Interval (s)</label>
							<Input
								type="number"
								value={state.interval}
								onChange={(e) =>
									dispatch({
										type: "SET_INTERVAL",
										payload: parseInt(e.target.value) || 10,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-1">
							<label className="text-xs font-medium">Timeout (s)</label>
							<Input
								type="number"
								value={state.timeout}
								onChange={(e) =>
									dispatch({
										type: "SET_TIMEOUT",
										payload: parseInt(e.target.value) || 5,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-1">
							<label className="text-xs font-medium">Retries</label>
							<Input
								type="number"
								value={state.retries}
								onChange={(e) =>
									dispatch({
										type: "SET_RETRIES",
										payload: parseInt(e.target.value) || 3,
									})
								}
								min={1}
							/>
						</div>
						<div className="space-y-1">
							<label className="text-xs font-medium">Start Period (s)</label>
							<Input
								type="number"
								value={state.startPeriod}
								onChange={(e) =>
									dispatch({
										type: "SET_START_PERIOD",
										payload: parseInt(e.target.value) || 30,
									})
								}
								min={0}
							/>
						</div>
					</div>
				)}

				<p className="text-xs text-muted-foreground">
					Changes apply on next deployment.
				</p>

				{(hasChanges || hasHealthCheck) && (
					<div className="flex gap-2">
						{hasChanges && (
							<Button onClick={handleSave} disabled={isSaving} size="sm">
								{isSaving ? "Saving..." : "Save"}
							</Button>
						)}
						{hasHealthCheck && (
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
			</CardContent>
		</Card>
	);
});
