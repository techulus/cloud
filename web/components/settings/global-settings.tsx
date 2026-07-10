"use client";

import {
	ArrowUpCircle,
	Clock,
	ExternalLink,
	Hammer,
	Info,
	Network,
	RefreshCw,
	Server,
	Shield,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useQueryState } from "nuqs";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	checkControlPlaneUpdatesNow,
	refreshControlPlaneAboutStatus,
	refreshControlPlaneUpgradeStatus,
	updateAcmeEmail,
	updateBuildServers,
	updateBuildTimeout,
	updateProxyDomain,
	upgradeControlPlane,
} from "@/actions/settings";
import { LocalDate } from "@/components/core/local-date";
import { ApiKeySettings } from "@/components/settings/api-key-settings";
import { EmailSettings } from "@/components/settings/email-settings";
import { MemberSettings } from "@/components/settings/member-settings";
import { TwoFactorSettings } from "@/components/settings/two-factor-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
	InvitableMemberRole,
	MemberRole,
	Server as ServerType,
} from "@/db/types";
import type {
	ControlPlaneUpdateState,
	ControlPlaneUpgradeState,
} from "@/lib/control-plane-updates";
import type { EmailAlertsConfig } from "@/lib/settings-keys";

type Props = {
	servers: ServerType[];
	membersData: {
		members: Array<{
			id: string;
			name: string;
			email: string;
			role: MemberRole;
			createdAt: string;
		}>;
		invitations: Array<{
			id: string;
			email: string;
			role: InvitableMemberRole;
			status: string;
			expiresAt: string;
			createdAt: string;
		}>;
	} | null;
	initialSettings: {
		buildServerIds: string[];
		buildTimeoutMinutes: number;
		acmeEmail: string | null;
		proxyDomain: string | null;
		emailAlertsConfig: EmailAlertsConfig | null;
		controlPlaneUpdateState: ControlPlaneUpdateState | null;
		controlPlaneUpgradeState: ControlPlaneUpgradeState | null;
	};
	appVersion: string | null;
};

const CONTROL_PLANE_UPGRADE_DOCS_URL =
	"https://docs.techulus.com/installation#manual-upgrades";

export function GlobalSettings({
	servers,
	membersData,
	initialSettings,
	appVersion,
}: Props) {
	const router = useRouter();
	const [tab, setTab] = useQueryState("tab", { defaultValue: "build" });
	const previousTabRef = useRef<string | null>(null);
	const [buildServerIds, setBuildServerIds] = useState<Set<string>>(
		new Set(initialSettings.buildServerIds),
	);
	const [buildTimeoutMinutes, setBuildTimeoutMinutes] = useState(
		String(initialSettings.buildTimeoutMinutes),
	);
	const [isSavingBuild, setIsSavingBuild] = useState(false);
	const [isSavingTimeout, setIsSavingTimeout] = useState(false);

	const [acmeEmail, setAcmeEmail] = useState(initialSettings.acmeEmail ?? "");
	const [proxyDomain, setProxyDomain] = useState(
		initialSettings.proxyDomain ?? "",
	);
	const [isSavingAcmeEmail, setIsSavingAcmeEmail] = useState(false);
	const [isSavingProxyDomain, setIsSavingProxyDomain] = useState(false);
	const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
	const [isStartingUpgrade, setIsStartingUpgrade] = useState(false);
	const [isRefreshingUpgrade, setIsRefreshingUpgrade] = useState(false);
	const [controlPlaneUpgradeDialogOpen, setControlPlaneUpgradeDialogOpen] =
		useState(false);

	useEffect(() => {
		const openedAbout = tab === "about" && previousTabRef.current !== "about";
		previousTabRef.current = tab;

		if (!openedAbout) return;

		let cancelled = false;

		async function refreshAboutStatus() {
			try {
				await refreshControlPlaneAboutStatus();
				if (!cancelled) {
					router.refresh();
				}
			} catch (error) {
				console.error("Failed to refresh about status", error);
			}
		}

		refreshAboutStatus();

		return () => {
			cancelled = true;
		};
	}, [tab, router]);

	const toggleBuildServer = (serverId: string) => {
		setBuildServerIds((prev) => {
			const next = new Set(prev);
			if (next.has(serverId)) {
				next.delete(serverId);
			} else {
				next.add(serverId);
			}
			return next;
		});
	};

	const handleSaveBuildServers = async () => {
		setIsSavingBuild(true);
		try {
			await updateBuildServers(Array.from(buildServerIds));
			toast.success("Build servers updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingBuild(false);
		}
	};

	const handleSaveBuildTimeout = async () => {
		setIsSavingTimeout(true);
		try {
			await updateBuildTimeout(parseInt(buildTimeoutMinutes, 10));
			toast.success("Build timeout updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update settings",
			);
		} finally {
			setIsSavingTimeout(false);
		}
	};

	const handleSaveAcmeEmail = async () => {
		setIsSavingAcmeEmail(true);
		try {
			await updateAcmeEmail(acmeEmail);
			toast.success("ACME email updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to update ACME email",
			);
		} finally {
			setIsSavingAcmeEmail(false);
		}
	};

	const handleSaveProxyDomain = async () => {
		setIsSavingProxyDomain(true);
		try {
			await updateProxyDomain(proxyDomain);
			toast.success("Proxy domain updated");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update proxy domain",
			);
		} finally {
			setIsSavingProxyDomain(false);
		}
	};

	const handleCheckUpdates = async () => {
		setIsCheckingUpdates(true);
		try {
			const state = await checkControlPlaneUpdatesNow();
			if (state.error) {
				toast.error(state.error);
			} else if (state.updateAvailable && state.latestVersion) {
				toast.success(`Update available: ${state.latestVersion}`);
			} else {
				toast.success("Control plane is up to date");
			}
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to check updates",
			);
		} finally {
			setIsCheckingUpdates(false);
		}
	};

	const handleStartUpgrade = async (targetVersion: string) => {
		setIsStartingUpgrade(true);
		try {
			await upgradeControlPlane(targetVersion);
			toast.success("Control plane upgrade started");
			setControlPlaneUpgradeDialogOpen(false);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to start upgrade",
			);
		} finally {
			setIsStartingUpgrade(false);
		}
	};

	const handleRefreshUpgradeStatus = async () => {
		setIsRefreshingUpgrade(true);
		try {
			const state = await refreshControlPlaneUpgradeStatus();
			if (state.status === "succeeded") {
				toast.success("Upgrade completed");
			} else if (state.status === "failed") {
				toast.error(state.error ?? "Upgrade failed");
			} else {
				toast.info(`Upgrade status: ${state.status}`);
			}
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to refresh upgrade status",
			);
		} finally {
			setIsRefreshingUpgrade(false);
		}
	};

	const buildServersChanged =
		buildServerIds.size !== initialSettings.buildServerIds.length ||
		!initialSettings.buildServerIds.every((id) => buildServerIds.has(id));

	const buildTimeoutChanged =
		buildTimeoutMinutes !== String(initialSettings.buildTimeoutMinutes);

	const acmeEmailChanged = acmeEmail !== (initialSettings.acmeEmail ?? "");
	const proxyDomainChanged =
		proxyDomain !== (initialSettings.proxyDomain ?? "");
	const updateState = initialSettings.controlPlaneUpdateState;
	const upgradeState = initialSettings.controlPlaneUpgradeState;
	const displayVersion = updateState?.currentVersion ?? appVersion ?? "dev";
	const upgradeRunning = upgradeState?.status === "running";

	return (
		<Tabs value={tab} onValueChange={(value) => setTab(value)}>
			<TabsList className="w-full justify-start overflow-x-auto">
				<TabsTrigger value="build" className="px-4 shrink-0">
					Build
				</TabsTrigger>
				<TabsTrigger value="infrastructure" className="px-4 shrink-0">
					Infrastructure
				</TabsTrigger>
				<TabsTrigger value="email" className="px-4 shrink-0">
					Email
				</TabsTrigger>
				<TabsTrigger value="security" className="px-4 shrink-0">
					Security
				</TabsTrigger>
				<TabsTrigger value="api-keys" className="px-4 shrink-0">
					API Keys
				</TabsTrigger>
				{membersData && (
					<TabsTrigger value="members" className="px-4 shrink-0">
						Members
					</TabsTrigger>
				)}
				<TabsTrigger value="about" className="px-4 shrink-0">
					About
				</TabsTrigger>
			</TabsList>

			<TabsContent value="build" className="space-y-6 pt-4">
				{servers.length === 0 && (
					<Empty className="border py-10">
						<EmptyMedia variant="icon">
							<Server />
						</EmptyMedia>
						<EmptyTitle>No servers</EmptyTitle>
						<EmptyDescription>
							Add servers to configure build settings.
						</EmptyDescription>
					</Empty>
				)}
				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Hammer className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Build Servers</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<p className="text-sm text-muted-foreground">
							Select which servers can run builds. If none are selected, all
							online servers can run builds.
						</p>
						<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
							{servers.map((server) => (
								<button
									type="button"
									key={server.id}
									onClick={() => toggleBuildServer(server.id)}
									className={`flex items-center gap-4 p-3 rounded-md text-left transition-colors ${
										buildServerIds.has(server.id)
											? "bg-primary text-primary-foreground"
											: "bg-muted hover:bg-muted/80"
									}`}
								>
									<div className="flex-1 min-w-0">
										<p className="font-medium truncate">{server.name}</p>
										<p
											className={`text-xs font-mono ${
												buildServerIds.has(server.id)
													? "text-primary-foreground/70"
													: "text-muted-foreground"
											}`}
										>
											{server.wireguardIp || server.publicIp || "No IP"}
										</p>
									</div>
								</button>
							))}
						</div>
						<div className="flex items-center justify-between text-sm">
							<span>
								{buildServerIds.size === 0
									? "All servers can build"
									: `${buildServerIds.size} server${buildServerIds.size !== 1 ? "s" : ""} selected`}
							</span>
						</div>
						{buildServersChanged && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSaveBuildServers}
									disabled={isSavingBuild}
									size="sm"
								>
									{isSavingBuild ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>
				</div>

				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Clock className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Build Timeout</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<p className="text-sm text-muted-foreground">
							Maximum time allowed for builds to complete. Builds exceeding this
							limit will be automatically cancelled.
						</p>
						<div className="flex items-center gap-3">
							<Input
								type="number"
								min={5}
								max={120}
								value={buildTimeoutMinutes}
								onChange={(e) => setBuildTimeoutMinutes(e.target.value)}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">minutes</span>
						</div>
						<p className="text-xs text-muted-foreground">
							Minimum: 5 minutes, Maximum: 120 minutes
						</p>
						{buildTimeoutChanged && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSaveBuildTimeout}
									disabled={isSavingTimeout}
									size="sm"
								>
									{isSavingTimeout ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>
				</div>
			</TabsContent>

			<TabsContent value="infrastructure" className="space-y-6 pt-4">
				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Shield className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>SSL/ACME Email</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<p className="text-sm text-muted-foreground">
							Email address used for Let&apos;s Encrypt SSL certificate
							registration. You will receive expiration notifications at this
							address.
						</p>
						<div className="space-y-2">
							<Label htmlFor="acme-email">Email Address</Label>
							<Input
								id="acme-email"
								type="email"
								value={acmeEmail}
								onChange={(e) => setAcmeEmail(e.target.value)}
								placeholder="ssl@example.com"
							/>
						</div>
						{acmeEmailChanged && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSaveAcmeEmail}
									disabled={isSavingAcmeEmail}
									size="sm"
								>
									{isSavingAcmeEmail ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>
				</div>

				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Network className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Proxy Domain</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<p className="text-sm text-muted-foreground">
							Domain used for TCP/UDP proxy connections. This should point to
							your proxy server.
						</p>
						<div className="space-y-2">
							<Label htmlFor="proxy-domain">Domain</Label>
							<Input
								id="proxy-domain"
								value={proxyDomain}
								onChange={(e) => setProxyDomain(e.target.value)}
								placeholder="proxy.example.com"
							/>
						</div>
						{proxyDomainChanged && (
							<div className="pt-3 border-t">
								<Button
									onClick={handleSaveProxyDomain}
									disabled={isSavingProxyDomain}
									size="sm"
								>
									{isSavingProxyDomain ? "Saving..." : "Save"}
								</Button>
							</div>
						)}
					</div>
				</div>
			</TabsContent>

			<TabsContent value="email" className="space-y-6 pt-4">
				<EmailSettings
					initialAlertsConfig={initialSettings.emailAlertsConfig}
				/>
			</TabsContent>

			<TabsContent value="security" className="space-y-6 pt-4">
				<TwoFactorSettings />
			</TabsContent>

			<TabsContent value="api-keys" className="space-y-6 pt-4">
				<ApiKeySettings />
			</TabsContent>

			{membersData && (
				<TabsContent value="members" className="space-y-6 pt-4">
					<MemberSettings
						initialMembers={membersData.members}
						initialInvitations={membersData.invitations}
					/>
				</TabsContent>
			)}

			<TabsContent value="about" className="space-y-6 pt-4">
				<div className="rounded-lg border">
					<Item className="border-0 border-b rounded-none">
						<ItemMedia variant="icon">
							<Info className="size-5 text-muted-foreground" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Control Plane Updates</ItemTitle>
						</ItemContent>
					</Item>
					<div className="p-4 space-y-4">
						<div className="grid gap-3 sm:grid-cols-3">
							<div>
								<p className="text-xs text-muted-foreground">Current version</p>
								<p className="font-mono text-sm">{displayVersion}</p>
							</div>
							<div>
								<p className="text-xs text-muted-foreground">Latest version</p>
								<p className="font-mono text-sm">
									{updateState?.latestVersion ?? "Not checked"}
								</p>
							</div>
							<div>
								<p className="text-xs text-muted-foreground">Last checked</p>
								<p className="text-sm">
									<LocalDate
										value={updateState?.checkedAt}
										fallback={updateState?.checkedAt ? "Unknown" : "Never"}
									/>
								</p>
							</div>
						</div>

						{updateState?.channel === "rolling" && (
							<div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
								This instance is running the rolling channel ({displayVersion}),
								so release update prompts are disabled.
							</div>
						)}

						{updateState?.channel === "unknown" && (
							<div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
								This instance version is not a release tag, so update prompts
								are disabled.
							</div>
						)}

						{updateState?.error && (
							<div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
								{updateState.error}
							</div>
						)}

						{updateState?.updateAvailable && updateState.latestVersion && (
							<div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
								<div className="flex items-center gap-2 font-medium">
									<ArrowUpCircle className="size-4" />
									Control plane update available: {displayVersion} →{" "}
									{updateState.latestVersion}
								</div>
							</div>
						)}

						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={handleCheckUpdates}
								disabled={isCheckingUpdates}
							>
								<RefreshCw
									className={isCheckingUpdates ? "animate-spin" : ""}
								/>
								{isCheckingUpdates ? "Checking..." : "Check for updates"}
							</Button>

							{updateState?.releaseUrl && (
								<Button
									variant="outline"
									render={
										<a
											href={updateState.releaseUrl}
											target="_blank"
											rel="noreferrer"
										>
											<ExternalLink />
											Release notes
										</a>
									}
								></Button>
							)}

							{updateState?.updateAvailable && updateState.latestVersion && (
								<Dialog
									open={controlPlaneUpgradeDialogOpen}
									onOpenChange={setControlPlaneUpgradeDialogOpen}
								>
									<DialogTrigger
										render={
											<Button variant="warning" disabled={upgradeRunning} />
										}
									>
										Upgrade to {updateState.latestVersion}
									</DialogTrigger>
									<DialogContent className="sm:max-w-2xl">
										<DialogHeader>
											<DialogTitle>Upgrade control plane</DialogTitle>
											<DialogDescription>
												This starts the internal updater service, which backs up
												the environment file, refreshes the release compose
												files, pulls images, and restarts the stack.
											</DialogDescription>
										</DialogHeader>
										<div className="text-xs text-muted-foreground">
											The updater creates a database backup before running the
											new version. Rollback after migrations may require
											restoring that backup. Prefer the one-click upgrade; use
											manual upgrade steps only if the updater cannot run. See{" "}
											<a
												href={CONTROL_PLANE_UPGRADE_DOCS_URL}
												target="_blank"
												rel="noreferrer"
												className="underline underline-offset-2"
											>
												the installation docs
											</a>
											.
										</div>
										<DialogFooter showCloseButton>
											<Button
												type="button"
												variant="warning"
												onClick={() => {
													if (updateState.latestVersion) {
														handleStartUpgrade(updateState.latestVersion);
													}
												}}
												disabled={isStartingUpgrade || upgradeRunning}
											>
												{isStartingUpgrade ? "Starting..." : "Start upgrade"}
											</Button>
										</DialogFooter>
									</DialogContent>
								</Dialog>
							)}

							{updateState &&
								!updateState.updateAvailable &&
								!updateState.error && (
									<Badge variant="secondary">Up to date</Badge>
								)}
						</div>
					</div>
				</div>

				{upgradeState && upgradeState.status !== "idle" && (
					<div className="rounded-lg border p-4 text-sm">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div>
								<p className="font-medium">
									Upgrade status: {upgradeState.status}
									{upgradeState.targetVersion
										? ` (${upgradeState.targetVersion})`
										: ""}
								</p>
								{upgradeState.error && (
									<p className="text-destructive">{upgradeState.error}</p>
								)}
							</div>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={handleRefreshUpgradeStatus}
								disabled={isRefreshingUpgrade}
							>
								{isRefreshingUpgrade ? "Refreshing..." : "Refresh status"}
							</Button>
						</div>
						{upgradeState.logs.length > 0 && (
							<code className="mt-3 block max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs font-mono text-muted-foreground">
								{upgradeState.logs.slice(-20).join("\n")}
							</code>
						)}
					</div>
				)}
			</TabsContent>
		</Tabs>
	);
}
