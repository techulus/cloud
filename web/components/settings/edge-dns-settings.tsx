"use client";

import { Network } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
	saveEdgeDnsConfig,
	syncEdgeDnsNow,
	testEdgeDnsConnection,
} from "@/actions/settings";
import { LocalDate } from "@/components/core/local-date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export type EdgeDnsOverview = {
	hostname: string | null;
	hostnameSource: "env" | "fallback" | "unconfigured";
	config: {
		enabled: boolean;
		zoneId: string;
		claimedHostname: string;
		hasAccessKey: boolean;
	} | null;
	sync: {
		status: "idle" | "syncing" | "success" | "error" | "skipped";
		lastAttemptAt?: string;
		lastSuccessAt?: string;
		desiredTargets: string[];
		currentTargets: string[];
		error?: string;
		message?: string;
	};
	excluded: Array<{ id: string; name: string; reasons: string[] }>;
};

export function EdgeDnsSettings({ initial }: { initial: EdgeDnsOverview }) {
	const router = useRouter();
	const config = initial.config;
	const [form, setForm] = useState({
		enabled: config?.enabled ?? false,
		zoneId: config?.zoneId ?? "",
		accessKey: "",
		confirmScope: false,
	});
	const [busy, setBusy] = useState(false);
	async function run(action: "test" | "save" | "sync") {
		setBusy(true);
		try {
			if (action === "test") await testEdgeDnsConnection(form);
			else if (action === "save") await saveEdgeDnsConfig(form);
			else await syncEdgeDnsNow();
			toast.success(
				action === "test"
					? "Connection validated"
					: action === "save"
						? "Saved and synchronization queued"
						: "Synchronization queued",
			);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Edge DNS action failed",
			);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Network className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Edge DNS</ItemTitle>
				</ItemContent>
				<Badge variant="outline">{initial.sync.status}</Badge>
			</Item>
			<div className="p-4 space-y-5">
				<div>
					<Label>Effective hostname</Label>
					<div className="font-mono text-sm mt-1">
						{initial.hostname ?? "Not configured"}
					</div>
					<p className="text-xs text-muted-foreground">
						Source: {initial.hostnameSource}. EDGE_DOMAIN takes precedence over
						the legacy database fallback.
					</p>
				</div>
				<p className="text-sm text-muted-foreground">
					Techulus manages only membership of the explicitly claimed A-record
					set. Bunny routing, monitoring, weights, and TTL policy remain under
					your control.
				</p>
				{config?.claimedHostname && (
					<p className="text-sm">
						Claimed scope:{" "}
						<span className="font-mono">{config.claimedHostname}</span>
						{" / zone "}
						<span className="font-mono">{config.zoneId}</span>
					</p>
				)}
				<div className="flex items-center gap-3">
					<Switch
						id="edge-enabled"
						checked={form.enabled}
						onCheckedChange={(enabled) => setForm((v) => ({ ...v, enabled }))}
					/>
					<Label htmlFor="edge-enabled">Enable Bunny DNS synchronization</Label>
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="edge-zone">Zone ID</Label>
						<Input
							id="edge-zone"
							value={form.zoneId}
							onChange={(e) =>
								setForm((v) => ({ ...v, zoneId: e.target.value }))
							}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="edge-key">API key</Label>
						<Input
							id="edge-key"
							type="password"
							autoComplete="new-password"
							value={form.accessKey}
							placeholder={
								config?.hasAccessKey
									? "Stored — leave blank to preserve"
									: "Bunny AccessKey"
							}
							onChange={(e) =>
								setForm((v) => ({ ...v, accessKey: e.target.value }))
							}
						/>
					</div>
				</div>
				<div className="flex items-start gap-3 rounded-md border p-3">
					<Switch
						id="edge-confirm-scope"
						checked={form.confirmScope}
						onCheckedChange={(confirmScope) =>
							setForm((value) => ({ ...value, confirmScope }))
						}
					/>
					<Label htmlFor="edge-confirm-scope" className="font-normal leading-5">
						I authorize Techulus to adopt existing A records at this exact
						hostname when claiming or changing scope. Records in a previous
						scope are left unchanged.
					</Label>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={() => run("test")}
						disabled={busy || !initial.hostname || !form.zoneId}
					>
						Test connection
					</Button>
					<Button
						onClick={() => run("save")}
						disabled={busy || (form.enabled && !initial.hostname)}
					>
						Save and sync
					</Button>
					<Button
						variant="secondary"
						onClick={() => run("sync")}
						disabled={busy || !config?.enabled || !config.hasAccessKey}
					>
						Sync now
					</Button>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<TargetList
						label="Desired IPv4 targets"
						values={initial.sync.desiredTargets}
					/>
					<TargetList
						label="Current managed targets"
						values={initial.sync.currentTargets}
					/>
				</div>
				{(initial.sync.error || initial.sync.message) && (
					<output className="block text-sm text-muted-foreground">
						{initial.sync.error ?? initial.sync.message}
					</output>
				)}
				{initial.sync.lastSuccessAt && (
					<p className="text-xs text-muted-foreground">
						Last success: <LocalDate value={initial.sync.lastSuccessAt} />
					</p>
				)}
				{initial.excluded.length > 0 && (
					<div>
						<Label>Excluded proxies</Label>
						<ul className="mt-2 space-y-1 text-sm text-muted-foreground">
							{initial.excluded.map((proxy) => (
								<li key={proxy.id}>
									<span className="font-medium text-foreground">
										{proxy.name}:
									</span>{" "}
									{proxy.reasons.join(", ")}
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
}

function TargetList({ label, values }: { label: string; values: string[] }) {
	return (
		<div>
			<Label>{label}</Label>
			<div className="mt-2 flex flex-wrap gap-1">
				{values.length ? (
					values.map((ip) => (
						<Badge key={ip} variant="secondary" className="font-mono">
							{ip}
						</Badge>
					))
				) : (
					<span className="text-sm text-muted-foreground">None</span>
				)}
			</div>
		</div>
	);
}
