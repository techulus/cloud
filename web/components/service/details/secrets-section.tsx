"use client";

import { useState, memo, type ClipboardEvent } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Key, Plus, X, Save } from "lucide-react";
import { toast } from "sonner";
import { createSecretsBatch, deleteSecretsBatch } from "@/actions/secrets";
import type { Secret, ServiceWithDetails as Service } from "@/db/types";
import { fetcher } from "@/lib/fetcher";

function parseEnvContent(content: string): { key: string; value: string }[] {
	const lines = content.split("\n");
	const results: { key: string; value: string }[] = [];
	const keyRegex = /^[A-Z_][A-Z0-9_]*$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;

		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (keyRegex.test(key) && value) {
			results.push({ key, value });
		}
	}

	return results;
}

export const SecretsSection = memo(function SecretsSection({
	service,
	onUpdate,
}: {
	service: Service;
	onUpdate: () => void;
}) {
	const {
		data: secrets,
		isLoading,
		mutate,
	} = useSWR<Pick<Secret, "id" | "key" | "createdAt">[]>(
		`/api/services/${service.id}/secrets`,
		fetcher,
	);
	const [newKey, setNewKey] = useState("");
	const [newValue, setNewValue] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [pendingVars, setPendingVars] = useState<
		{ key: string; value: string }[]
	>([]);
	const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);

	const keyRegex = /^[A-Z_][A-Z0-9_]*$/;
	const isValidKey = newKey.trim() && keyRegex.test(newKey.trim());
	const canAdd = isValidKey && newValue.trim();

	const hasChanges = pendingVars.length > 0 || pendingDeletes.length > 0;

	const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
		const pasted = e.clipboardData.getData("text");
		if (pasted.includes("\n") || pasted.includes("=")) {
			const parsed = parseEnvContent(pasted);
			if (parsed.length > 0) {
				e.preventDefault();
				const pendingKeys = new Set(pendingVars.map((v) => v.key));
				const newVars = parsed.filter((v) => !pendingKeys.has(v.key));
				if (newVars.length > 0) {
					setPendingVars((prev) => [...prev, ...newVars]);
				}
			}
		}
	};

	const handleAdd = () => {
		if (!canAdd) return;
		const key = newKey.trim();
		const pendingKeys = new Set(pendingVars.map((v) => v.key));
		if (pendingKeys.has(key)) return;
		setPendingVars((prev) => [...prev, { key, value: newValue }]);
		setNewKey("");
		setNewValue("");
	};

	const handleRemovePending = (index: number) => {
		setPendingVars((prev) => prev.filter((_, i) => i !== index));
	};

	const handleDelete = (secretId: string) => {
		setPendingDeletes((prev) => [...prev, secretId]);
	};

	const handleUndoDelete = (secretId: string) => {
		setPendingDeletes((prev) => prev.filter((id) => id !== secretId));
	};

	const handleSave = async () => {
		if (!hasChanges) return;
		setIsSaving(true);
		try {
			if (pendingVars.length > 0) {
				await createSecretsBatch(service.id, pendingVars);
			}
			if (pendingDeletes.length > 0) {
				await deleteSecretsBatch(pendingDeletes);
			}
			await mutate();
			setPendingVars([]);
			setPendingDeletes([]);
			toast.success("Environment variables saved");
			onUpdate();
		} catch {
			toast.error("Failed to save changes");
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Key className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Environment Variables</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				{isLoading ? (
					<div className="text-base text-muted-foreground">Loading...</div>
				) : secrets && secrets.length > 0 ? (
					<div className="space-y-2">
						{secrets.map((secret) => {
							const isDeleting = pendingDeletes.includes(secret.id);
							return (
								<div
									key={secret.id}
									className={`flex items-center justify-between px-3 py-2 rounded-md text-base bg-muted ${isDeleting ? "opacity-50" : ""}`}
								>
									<div className="flex items-center gap-2">
										<span
											className={`font-mono font-medium ${isDeleting ? "line-through" : ""}`}
										>
											{secret.key}
										</span>
										<span className="text-muted-foreground">= ••••••••</span>
									</div>
									{isDeleting ? (
										<button
											type="button"
											onClick={() => handleUndoDelete(secret.id)}
											className="text-sm text-muted-foreground hover:text-foreground"
										>
											Undo
										</button>
									) : (
										<button
											type="button"
											onClick={() => handleDelete(secret.id)}
											className="text-muted-foreground hover:text-foreground"
										>
											<X className="h-4 w-4" />
										</button>
									)}
								</div>
							);
						})}
					</div>
				) : pendingVars.length === 0 ? (
					<div className="text-base text-muted-foreground">
						No environment variables configured
					</div>
				) : null}

				{pendingVars.length > 0 && (
					<div className="space-y-2">
						{secrets && secrets.length > 0 && (
							<div className="text-sm text-muted-foreground font-medium pt-2">
								New variables
							</div>
						)}
						{pendingVars.map((variable, index) => (
							<div
								key={`${variable.key}-${index}`}
								className="flex items-center justify-between px-3 py-2 rounded-md text-base bg-green-500/10 border border-green-500/20"
							>
								<div className="flex items-center gap-2 min-w-0 flex-1">
									<span className="font-mono font-medium">{variable.key}</span>
									<span className="text-muted-foreground">=</span>
									<span className="font-mono text-muted-foreground truncate">
										{variable.value}
									</span>
								</div>
								<button
									type="button"
									onClick={() => handleRemovePending(index)}
									className="text-muted-foreground hover:text-foreground ml-2 flex-shrink-0"
								>
									<X className="h-4 w-4" />
								</button>
							</div>
						))}
					</div>
				)}

				<div className="space-y-2">
					<div className="flex items-center gap-2">
						<Input
							type="text"
							placeholder="KEY_NAME"
							value={newKey}
							onChange={(e) => setNewKey(e.target.value)}
							onPaste={handlePaste}
							className="flex-1 font-mono"
						/>
						<span className="text-muted-foreground">=</span>
						<Input
							type="text"
							placeholder="value"
							value={newValue}
							onChange={(e) => setNewValue(e.target.value)}
							className="flex-1 font-mono"
						/>
						<Button
							size="sm"
							variant="outline"
							onClick={handleAdd}
							disabled={!canAdd}
						>
							<Plus className="h-4 w-4" />
						</Button>
					</div>
					{newKey && !isValidKey && (
						<p className="text-sm text-destructive">
							Key must start with a letter or underscore, contain only uppercase
							letters, numbers, and underscores
						</p>
					)}
				</div>

				{hasChanges && (
					<div className="flex items-center justify-between pt-2 border-t">
						<p className="text-sm text-muted-foreground">
							{pendingVars.length > 0 && `${pendingVars.length} to add`}
							{pendingVars.length > 0 && pendingDeletes.length > 0 && ", "}
							{pendingDeletes.length > 0 &&
								`${pendingDeletes.length} to remove`}
						</p>
						<Button size="sm" onClick={handleSave} disabled={isSaving}>
							<Save className="h-4 w-4 mr-2" />
							{isSaving ? "Saving..." : "Save Changes"}
						</Button>
					</div>
				)}

				{(secrets?.length ?? 0) > 0 && !hasChanges && (
					<p className="text-sm text-muted-foreground">
						Changes take effect on next deployment
					</p>
				)}
			</div>
		</div>
	);
});
