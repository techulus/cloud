"use client";

import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useReducer } from "react";
import { toast } from "sonner";
import { updateEmailAlertsConfig } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { EmailAlertsConfig } from "@/lib/settings-keys";

type Props = {
	initialAlertsConfig: EmailAlertsConfig | null;
};

type AlertField =
	| "serverOfflineAlert"
	| "buildFailure"
	| "deploymentFailure"
	| "deploymentMovedAlert";

type AlertSetting = {
	field: AlertField;
	label: string;
	description: string;
};

const ALERT_SETTINGS: AlertSetting[] = [
	{
		field: "serverOfflineAlert",
		label: "Server Offline Alert",
		description: "Receive an email when a server goes offline",
	},
	{
		field: "buildFailure",
		label: "Build Failure Alert",
		description: "Receive an email when a build fails",
	},
	{
		field: "deploymentFailure",
		label: "Deployment Failure Alert",
		description: "Receive an email when a deployment fails",
	},
	{
		field: "deploymentMovedAlert",
		label: "Deployment Moved Alert",
		description: "Receive an email when a service is automatically redeployed",
	},
];

type State = {
	serverOfflineAlert: boolean;
	buildFailure: boolean;
	deploymentFailure: boolean;
	deploymentMovedAlert: boolean;
	isSavingAlerts: boolean;
};

type Action =
	| { type: "SET_ALERT"; field: AlertField; value: boolean }
	| { type: "SET_LOADING"; value: boolean };

function createInitialState(props: Props): State {
	const { initialAlertsConfig: alertsConfig } = props;
	return {
		serverOfflineAlert: alertsConfig?.serverOfflineAlert ?? true,
		buildFailure: alertsConfig?.buildFailure ?? true,
		deploymentFailure: alertsConfig?.deploymentFailure ?? true,
		deploymentMovedAlert: alertsConfig?.deploymentMovedAlert ?? true,
		isSavingAlerts: false,
	};
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "SET_ALERT":
			return { ...state, [action.field]: action.value };
		case "SET_LOADING":
			return { ...state, isSavingAlerts: action.value };
	}
}

export function EmailSettings({ initialAlertsConfig }: Props) {
	const router = useRouter();
	const [state, dispatch] = useReducer(
		reducer,
		{ initialAlertsConfig },
		createInitialState,
	);

	const handleSaveAlerts = async () => {
		dispatch({ type: "SET_LOADING", value: true });
		try {
			await updateEmailAlertsConfig({
				serverOfflineAlert: state.serverOfflineAlert,
				buildFailure: state.buildFailure,
				deploymentFailure: state.deploymentFailure,
				deploymentMovedAlert: state.deploymentMovedAlert,
			});
			toast.success("Alert settings saved");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to save alert settings",
			);
		} finally {
			dispatch({ type: "SET_LOADING", value: false });
		}
	};

	const hasAlertsChanges = useMemo(() => {
		return ALERT_SETTINGS.some(
			(setting) =>
				state[setting.field] !== (initialAlertsConfig?.[setting.field] ?? true),
		);
	}, [
		state.serverOfflineAlert,
		state.buildFailure,
		state.deploymentFailure,
		state.deploymentMovedAlert,
		initialAlertsConfig,
	]);

	return (
		<div className="space-y-6">
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Bell className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>Notifications</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Configure which email notifications you want to receive. SMTP
						settings are configured via environment variables.
					</p>

					<div className="space-y-4">
						{ALERT_SETTINGS.map((setting) => (
							<div
								key={setting.field}
								className="flex items-center justify-between"
							>
								<div className="space-y-0.5">
									<Label htmlFor={setting.field}>{setting.label}</Label>
									<p className="text-xs text-muted-foreground">
										{setting.description}
									</p>
								</div>
								<Switch
									id={setting.field}
									checked={state[setting.field]}
									onCheckedChange={(value) =>
										dispatch({
											type: "SET_ALERT",
											field: setting.field,
											value,
										})
									}
								/>
							</div>
						))}
					</div>

					{hasAlertsChanges && (
						<div className="pt-3 border-t">
							<Button
								onClick={handleSaveAlerts}
								disabled={state.isSavingAlerts}
								size="sm"
							>
								{state.isSavingAlerts ? "Saving..." : "Save Alert Settings"}
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
