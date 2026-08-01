"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
	createRegistryCredential,
	deleteRegistryCredential,
} from "@/actions/registry-credentials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RegistryMetadata } from "@/lib/registry-credentials";

export function RegistrySettings({
	registries,
}: {
	registries: RegistryMetadata[];
}) {
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [tlsVerify, setTlsVerify] = useState(true);
	const [busy, setBusy] = useState(false);

	async function create() {
		setBusy(true);
		try {
			await createRegistryCredential({ host, username, password, tlsVerify });
			toast.success("Registry added");
			window.location.reload();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to add registry",
			);
			setBusy(false);
		}
	}

	return (
		<div className="space-y-6">
			<div className="rounded-lg border p-4 space-y-4">
				<div>
					<h3 className="font-medium">Add registry credentials</h3>
					<p className="text-sm text-muted-foreground">
						Credentials are distributed globally to every registered agent. The
						password is write-only. To change credentials later, delete the
						registry and add it again.
					</p>
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					<div className="space-y-2">
						<Label htmlFor="registry-host">Host</Label>
						<Input
							id="registry-host"
							value={host}
							onChange={(event) => setHost(event.target.value)}
							placeholder="registry.example.com:5000"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="registry-username">Username</Label>
						<Input
							id="registry-username"
							value={username}
							onChange={(event) => setUsername(event.target.value)}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="registry-password">Password or token</Label>
						<Input
							id="registry-password"
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
				</div>
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={tlsVerify}
						onChange={(event) => setTlsVerify(event.target.checked)}
					/>{" "}
					Verify TLS certificates
				</label>
				{!tlsVerify && (
					<p className="text-sm text-destructive">
						Warning: disabling TLS verification exposes registry credentials to
						interception.
					</p>
				)}
				<Button
					disabled={busy || !host || !username || !password}
					onClick={create}
				>
					{busy ? "Adding..." : "Add registry"}
				</Button>
			</div>
			<div className="space-y-3">
				{registries.length === 0 && (
					<p className="rounded-lg border p-6 text-sm text-muted-foreground">
						No registry credentials configured.
					</p>
				)}
				{registries.map((registry) => (
					<RegistryRow key={registry.id} registry={registry} />
				))}
			</div>
		</div>
	);
}

function RegistryRow({ registry }: { registry: RegistryMetadata }) {
	const [busy, setBusy] = useState(false);
	if (registry.system)
		return (
			<div className="rounded-lg border p-4">
				<div className="flex justify-between">
					<div>
						<p className="font-mono font-medium">{registry.host}</p>
						<p className="text-sm text-muted-foreground">
							Built-in registry · {registry.username} · TLS verification{" "}
							{registry.tlsVerify ? "enabled" : "disabled"}
						</p>
					</div>
					<span className="text-xs text-muted-foreground">Read-only</span>
				</div>
			</div>
		);
	async function remove() {
		if (
			!window.confirm(
				`Delete credentials for ${registry.host}? Existing image pulls may fail.`,
			)
		)
			return;
		setBusy(true);
		try {
			await deleteRegistryCredential(registry.id);
			toast.success("Registry deleted");
			window.location.reload();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to delete registry",
			);
			setBusy(false);
		}
	}
	return (
		<div className="rounded-lg border p-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<p className="font-mono font-medium">{registry.host}</p>
					<p className="text-sm text-muted-foreground">
						{registry.username} · TLS verification{" "}
						{registry.tlsVerify ? "enabled" : "disabled"}
					</p>
					<p className="mt-2 text-xs text-muted-foreground">
						Delete and add this registry again to change its credentials or TLS
						setting.
					</p>
				</div>
				<Button
					size="sm"
					variant="destructive"
					disabled={busy}
					onClick={remove}
				>
					{busy ? "Deleting..." : "Delete"}
				</Button>
			</div>
		</div>
	);
}
