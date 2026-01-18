"use client";

import { useReducer, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Mail, Send, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	NativeSelect,
	NativeSelectOption,
} from "@/components/ui/native-select";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import {
	updateSmtpConfig,
	testSmtpConnection,
	sendTestEmail,
	updateEmailAlertsConfig,
} from "@/actions/settings";
import {
	DEFAULT_SMTP_PORT,
	DEFAULT_SMTP_TIMEOUT,
	type SmtpConfig,
	type SmtpEncryption,
	type EmailAlertsConfig,
} from "@/lib/settings-keys";

type Props = {
	initialConfig: SmtpConfig | null;
	initialAlertsConfig: EmailAlertsConfig | null;
};

type State = {
	enabled: boolean;
	fromName: string;
	fromAddress: string;
	host: string;
	port: string;
	customPort: string;
	username: string;
	password: string;
	encryption: SmtpEncryption;
	timeout: string;
	alertEmails: string;
	testEmailAddress: string;
	serverOfflineAlert: boolean;
	buildFailure: boolean;
	deploymentFailure: boolean;
	isSaving: boolean;
	isTesting: boolean;
	isSendingTest: boolean;
	isSavingAlerts: boolean;
};

type StringField = "fromName" | "fromAddress" | "host" | "port" | "customPort" | "username" | "password" | "timeout" | "alertEmails" | "testEmailAddress";

type AlertField = "serverOfflineAlert" | "buildFailure" | "deploymentFailure";

type Action =
	| { type: "SET_STRING"; field: StringField; value: string }
	| { type: "SET_ENABLED"; value: boolean }
	| { type: "SET_ENCRYPTION"; value: SmtpEncryption }
	| { type: "SET_PORT"; port: string; customPort: string }
	| { type: "SET_ALERT"; field: AlertField; value: boolean }
	| { type: "SET_LOADING"; field: "isSaving" | "isTesting" | "isSendingTest" | "isSavingAlerts"; value: boolean };

function createInitialState(props: Props): State {
	const { initialConfig: config, initialAlertsConfig: alertsConfig } = props;
	return {
		enabled: config?.enabled ?? false,
		fromName: config?.fromName ?? "",
		fromAddress: config?.fromAddress ?? "",
		host: config?.host ?? "",
		port: String(config?.port ?? DEFAULT_SMTP_PORT),
		customPort: "",
		username: config?.username ?? "",
		password: config?.password ?? "",
		encryption: config?.encryption ?? "starttls",
		timeout: String((config?.timeout ?? DEFAULT_SMTP_TIMEOUT) / 1000),
		alertEmails: config?.alertEmails ?? "",
		testEmailAddress: "",
		serverOfflineAlert: alertsConfig?.serverOfflineAlert ?? true,
		buildFailure: alertsConfig?.buildFailure ?? true,
		deploymentFailure: alertsConfig?.deploymentFailure ?? true,
		isSaving: false,
		isTesting: false,
		isSendingTest: false,
		isSavingAlerts: false,
	};
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "SET_STRING":
			return { ...state, [action.field]: action.value };
		case "SET_ENABLED":
			return { ...state, enabled: action.value };
		case "SET_ENCRYPTION":
			return { ...state, encryption: action.value };
		case "SET_PORT":
			return { ...state, port: action.port, customPort: action.customPort };
		case "SET_ALERT":
			return { ...state, [action.field]: action.value };
		case "SET_LOADING":
			return { ...state, [action.field]: action.value };
	}
}

export function EmailSettings({ initialConfig, initialAlertsConfig }: Props) {
	const router = useRouter();
	const [state, dispatch] = useReducer(reducer, { initialConfig, initialAlertsConfig }, createInitialState);

	const isStandardPort = ["587", "465", "25"].includes(state.port);
	const currentPort = parseInt(isStandardPort ? state.port : state.customPort, 10) || DEFAULT_SMTP_PORT;
	const currentTimeout = (parseInt(state.timeout, 10) || 10) * 1000;

	const getConfig = (): SmtpConfig => ({
		enabled: state.enabled,
		fromName: state.fromName,
		fromAddress: state.fromAddress,
		host: state.host,
		port: currentPort,
		username: state.username,
		password: state.password,
		encryption: state.encryption,
		timeout: currentTimeout,
		alertEmails: state.alertEmails,
	});

	const handleSave = async () => {
		dispatch({ type: "SET_LOADING", field: "isSaving", value: true });
		try {
			await updateSmtpConfig(getConfig());
			toast.success("Email settings saved");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save settings",
			);
		} finally {
			dispatch({ type: "SET_LOADING", field: "isSaving", value: false });
		}
	};

	const handleTestConnection = async () => {
		dispatch({ type: "SET_LOADING", field: "isTesting", value: true });
		try {
			await testSmtpConnection(getConfig());
			toast.success("Connection successful");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Connection failed",
			);
		} finally {
			dispatch({ type: "SET_LOADING", field: "isTesting", value: false });
		}
	};

	const handleSendTestEmail = async () => {
		dispatch({ type: "SET_LOADING", field: "isSendingTest", value: true });
		try {
			await sendTestEmail(getConfig(), state.testEmailAddress);
			toast.success("Test email sent");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to send test email",
			);
		} finally {
			dispatch({ type: "SET_LOADING", field: "isSendingTest", value: false });
		}
	};

	const handleSaveAlerts = async () => {
		dispatch({ type: "SET_LOADING", field: "isSavingAlerts", value: true });
		try {
			await updateEmailAlertsConfig({
				serverOfflineAlert: state.serverOfflineAlert,
				buildFailure: state.buildFailure,
				deploymentFailure: state.deploymentFailure,
			});
			toast.success("Alert settings saved");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save alert settings",
			);
		} finally {
			dispatch({ type: "SET_LOADING", field: "isSavingAlerts", value: false });
		}
	};

	const hasSmtpChanges = useMemo(() => {
		if (!initialConfig) {
			return state.host !== "" || state.fromAddress !== "" || state.enabled;
		}
		return (
			state.enabled !== initialConfig.enabled ||
			state.fromName !== initialConfig.fromName ||
			state.fromAddress !== initialConfig.fromAddress ||
			state.host !== initialConfig.host ||
			currentPort !== initialConfig.port ||
			state.username !== initialConfig.username ||
			state.password !== initialConfig.password ||
			state.encryption !== initialConfig.encryption ||
			currentTimeout !== initialConfig.timeout ||
			state.alertEmails !== initialConfig.alertEmails
		);
	}, [
		state.enabled,
		state.fromName,
		state.fromAddress,
		state.host,
		state.username,
		state.password,
		state.encryption,
		state.alertEmails,
		initialConfig,
		currentPort,
		currentTimeout,
	]);

	const hasAlertsChanges = useMemo(() => {
		const initialServerOfflineAlert = initialAlertsConfig?.serverOfflineAlert ?? true;
		const initialBuildFailure = initialAlertsConfig?.buildFailure ?? true;
		const initialDeploymentFailure = initialAlertsConfig?.deploymentFailure ?? true;
		return (
			state.serverOfflineAlert !== initialServerOfflineAlert ||
			state.buildFailure !== initialBuildFailure ||
			state.deploymentFailure !== initialDeploymentFailure
		);
	}, [state.serverOfflineAlert, state.buildFailure, state.deploymentFailure, initialAlertsConfig]);

	const setString = useCallback(
		(field: StringField) => (e: React.ChangeEvent<HTMLInputElement>) => {
			dispatch({ type: "SET_STRING", field, value: e.target.value });
		},
		[],
	);

	const handlePortChange = (value: string) => {
		dispatch({
			type: "SET_PORT",
			port: value,
			customPort: value === "custom" ? state.customPort : "",
		});
	};

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
					<div className="space-y-2">
						<Label htmlFor="smtp-alert-emails">Notification Recipients</Label>
						<Input
							id="smtp-alert-emails"
							value={state.alertEmails}
							onChange={setString("alertEmails")}
							placeholder="alerts@example.com, admin@example.com"
						/>
						<p className="text-xs text-muted-foreground">
							Comma-separated email addresses to receive notifications
						</p>
					</div>

					<div className="pt-4 border-t space-y-4">
						<p className="text-sm text-muted-foreground">
							Customise your notifications
						</p>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label htmlFor="server-offline-alert">Server Offline Alert</Label>
								<p className="text-xs text-muted-foreground">
									Receive an email when a server goes offline
								</p>
							</div>
							<Switch
								id="server-offline-alert"
								checked={state.serverOfflineAlert}
								onCheckedChange={(value) => dispatch({ type: "SET_ALERT", field: "serverOfflineAlert", value })}
							/>
						</div>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label htmlFor="build-failure-alert">Build Failure Alert</Label>
								<p className="text-xs text-muted-foreground">
									Receive an email when a build fails
								</p>
							</div>
							<Switch
								id="build-failure-alert"
								checked={state.buildFailure}
								onCheckedChange={(value) => dispatch({ type: "SET_ALERT", field: "buildFailure", value })}
							/>
						</div>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label htmlFor="deployment-failure-alert">Deployment Failure Alert</Label>
								<p className="text-xs text-muted-foreground">
									Receive an email when a deployment fails
								</p>
							</div>
							<Switch
								id="deployment-failure-alert"
								checked={state.deploymentFailure}
								onCheckedChange={(value) => dispatch({ type: "SET_ALERT", field: "deploymentFailure", value })}
							/>
						</div>
					</div>

					{hasAlertsChanges && (
						<div className="pt-3 border-t">
							<Button onClick={handleSaveAlerts} disabled={state.isSavingAlerts} size="sm">
								{state.isSavingAlerts ? "Saving..." : "Save Alert Settings"}
							</Button>
						</div>
					)}
				</div>
			</div>

			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Mail className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>SMTP Configuration</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Configure SMTP settings to enable email notifications. These settings
						will be used to send system emails.
					</p>

					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="smtp-enabled">Enable Email Notifications</Label>
							<p className="text-xs text-muted-foreground">
								Turn on to send system emails
							</p>
						</div>
						<Switch
							id="smtp-enabled"
							checked={state.enabled}
							onCheckedChange={(value) => dispatch({ type: "SET_ENABLED", value })}
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
						<div className="space-y-2">
							<Label htmlFor="smtp-from-name">From Name</Label>
							<Input
								id="smtp-from-name"
								value={state.fromName}
								onChange={setString("fromName")}
								placeholder="Techulus Cloud"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-from-address">From Address</Label>
							<Input
								id="smtp-from-address"
								type="email"
								value={state.fromAddress}
								onChange={setString("fromAddress")}
								placeholder="noreply@example.com"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-host">SMTP Host</Label>
							<Input
								id="smtp-host"
								value={state.host}
								onChange={setString("host")}
								placeholder="smtp.example.com"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-port">Port</Label>
							<div className="flex gap-2">
								<NativeSelect
									id="smtp-port"
									value={isStandardPort ? state.port : "custom"}
									onChange={(e) => handlePortChange(e.target.value)}
									className="flex-1"
								>
									<NativeSelectOption value="587">587 (StartTLS)</NativeSelectOption>
									<NativeSelectOption value="465">465 (TLS/SSL)</NativeSelectOption>
									<NativeSelectOption value="25">25 (Unencrypted)</NativeSelectOption>
									<NativeSelectOption value="custom">Custom</NativeSelectOption>
								</NativeSelect>
								{!isStandardPort && (
									<Input
										type="number"
										min={1}
										max={65535}
										value={state.customPort}
										onChange={setString("customPort")}
										placeholder="Port"
										className="w-24"
									/>
								)}
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-username">Username</Label>
							<Input
								id="smtp-username"
								value={state.username}
								onChange={setString("username")}
								placeholder="smtp-user"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-password">Password</Label>
							<Input
								id="smtp-password"
								type="password"
								value={state.password}
								onChange={setString("password")}
								placeholder="••••••••"
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-encryption">Encryption</Label>
							<NativeSelect
								id="smtp-encryption"
								value={state.encryption}
								onChange={(e) => dispatch({ type: "SET_ENCRYPTION", value: e.target.value as SmtpEncryption })}
							>
								<NativeSelectOption value="starttls">StartTLS</NativeSelectOption>
								<NativeSelectOption value="tls">TLS/SSL</NativeSelectOption>
								<NativeSelectOption value="none">None</NativeSelectOption>
							</NativeSelect>
						</div>

						<div className="space-y-2">
							<Label htmlFor="smtp-timeout">Timeout (seconds)</Label>
							<Input
								id="smtp-timeout"
								type="number"
								min={1}
								max={60}
								value={state.timeout}
								onChange={setString("timeout")}
								placeholder="10"
							/>
						</div>
					</div>

					<div className="flex flex-wrap gap-2 pt-2">
						<Button
							variant="outline"
							size="sm"
							onClick={handleTestConnection}
							disabled={state.isTesting || !state.host}
						>
							{state.isTesting ? "Testing..." : "Test Connection"}
						</Button>
					</div>

					<div className="pt-4 border-t space-y-3">
						<div className="flex items-end gap-2">
							<div className="flex-1 space-y-2">
								<Label htmlFor="test-email-address">Send Test Email</Label>
								<Input
									id="test-email-address"
									type="email"
									value={state.testEmailAddress}
									onChange={setString("testEmailAddress")}
									placeholder="recipient@example.com"
								/>
							</div>
							<Button
								variant="outline"
								size="sm"
								onClick={handleSendTestEmail}
								disabled={state.isSendingTest || !state.host || !state.testEmailAddress}
							>
								<Send className="size-4 mr-2" />
								{state.isSendingTest ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>

					{hasSmtpChanges && (
						<div className="pt-3 border-t">
							<Button onClick={handleSave} disabled={state.isSaving} size="sm">
								{state.isSaving ? "Saving..." : "Save"}
							</Button>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
