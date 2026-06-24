"use client";

import {
	KeyRound,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

type ApiKeyRecord = {
	id: string;
	name: string | null;
	start: string | null;
	prefix: string | null;
	enabled: boolean;
	createdAt: string | Date;
	updatedAt: string | Date;
	expiresAt: string | Date | null;
	lastRequest: string | Date | null;
	metadata: Record<string, unknown> | null;
};

type ApiKeyListResponse = {
	apiKeys: ApiKeyRecord[];
	total: number;
};

type ApiKeyClient = {
	apiKey: {
		list: (options?: {
			query?: {
				limit?: number;
				offset?: number;
				sortBy?: string;
				sortDirection?: "asc" | "desc";
			};
		}) => Promise<{
			data: ApiKeyListResponse | null;
			error: { message?: string; error_description?: string } | null;
		}>;
		delete: (body: { keyId: string }) => Promise<{
			data: { success: boolean } | null;
			error: { message?: string; error_description?: string } | null;
		}>;
	};
};

const apiKeysClient = authClient as unknown as ApiKeyClient;

function getErrorMessage(
	error: { message?: string; error_description?: string } | null | undefined,
	fallback: string,
) {
	return error?.message || error?.error_description || fallback;
}

function formatDate(value: string | Date | null) {
	if (!value) return "Never";

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown";

	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function describeSource(apiKey: ApiKeyRecord) {
	const source = apiKey.metadata?.creationSource;
	if (source === "techulus-cli") return "CLI";
	if (source === "dashboard") return "Dashboard";
	return "Manual";
}

function getKeyPreview(apiKey: ApiKeyRecord) {
	if (apiKey.start) return `${apiKey.start}••••`;
	if (apiKey.prefix) return `${apiKey.prefix}••••`;
	return "Hidden";
}

export function ApiKeySettings() {
	const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);

	const sortedApiKeys = useMemo(
		() =>
			[...apiKeys].sort(
				(a, b) =>
					new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
			),
		[apiKeys],
	);

	const loadApiKeys = useCallback(async (mode: "initial" | "refresh") => {
		if (mode === "initial") setIsLoading(true);
		else setIsRefreshing(true);

		try {
			const response = await apiKeysClient.apiKey.list({
				query: {
					limit: 100,
					sortBy: "createdAt",
					sortDirection: "desc",
				},
			});

			if (response.error || !response.data) {
				throw new Error(
					getErrorMessage(response.error, "Failed to load API keys"),
				);
			}

			setApiKeys(response.data.apiKeys);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to load API keys",
			);
		} finally {
			setIsLoading(false);
			setIsRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void loadApiKeys("initial");
	}, [loadApiKeys]);

	async function handleRevoke(apiKey: ApiKeyRecord) {
		setRevokingId(apiKey.id);
		try {
			const response = await apiKeysClient.apiKey.delete({ keyId: apiKey.id });
			if (response.error || !response.data?.success) {
				throw new Error(
					getErrorMessage(response.error, "Failed to revoke API key"),
				);
			}

			setApiKeys((current) => current.filter((key) => key.id !== apiKey.id));
			toast.success("API key revoked");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to revoke API key",
			);
		} finally {
			setRevokingId(null);
		}
	}

	return (
		<div className="space-y-6">
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<KeyRound className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>API Keys</ItemTitle>
						<p className="text-sm text-muted-foreground">
							Manage keys created by CLI logins. Run <code>tc auth login</code> to
							create a new CLI session.
						</p>
					</ItemContent>
				</Item>

				<div className="p-4 space-y-5">
					<div className="flex items-center justify-between gap-3">
						<div>
							<p className="text-sm font-medium">CLI keys</p>
							<p className="text-xs text-muted-foreground">
								{apiKeys.length} key{apiKeys.length === 1 ? "" : "s"} on this
								account
							</p>
						</div>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => void loadApiKeys("refresh")}
							disabled={isRefreshing || isLoading}
						>
							{isRefreshing ? (
								<Spinner className="size-4" />
							) : (
								<RefreshCw className="size-4" />
							)}
							Refresh
						</Button>
					</div>

					{isLoading ? (
						<div className="flex items-center justify-center rounded-lg border border-dashed py-10">
							<Spinner className="size-5" />
						</div>
					) : sortedApiKeys.length === 0 ? (
						<Empty className="border border-dashed py-10">
							<EmptyMedia variant="icon">
								<KeyRound />
							</EmptyMedia>
							<EmptyTitle>No API keys</EmptyTitle>
							<EmptyDescription>
								Run <code>tc auth login</code> from the CLI to create one.
							</EmptyDescription>
						</Empty>
					) : (
						<div className="overflow-hidden rounded-lg border">
							{sortedApiKeys.map((apiKey, index) => (
								<div
									key={apiKey.id}
									className={`grid gap-3 p-4 md:grid-cols-[1.4fr_1fr_1fr_auto] md:items-center ${
										index > 0 ? "border-t" : ""
									}`}
								>
									<div className="min-w-0 space-y-1">
										<div className="flex flex-wrap items-center gap-2">
											<p className="truncate text-sm font-medium">
												{apiKey.name ?? "Untitled key"}
											</p>
											<Badge
												variant={apiKey.enabled ? "secondary" : "destructive"}
											>
												{apiKey.enabled ? "Active" : "Disabled"}
											</Badge>
											<Badge variant="outline">{describeSource(apiKey)}</Badge>
										</div>
										<p className="font-mono text-xs text-muted-foreground">
											{getKeyPreview(apiKey)}
										</p>
									</div>
									<div className="text-xs md:text-sm">
										<p className="text-muted-foreground">Created</p>
										<p>{formatDate(apiKey.createdAt)}</p>
									</div>
									<div className="text-xs md:text-sm">
										<p className="text-muted-foreground">Last used</p>
										<p>{formatDate(apiKey.lastRequest)}</p>
									</div>
									<AlertDialog>
										<AlertDialogTrigger
											render={<Button variant="destructive" size="sm" />}
										>
											<Trash2 className="size-4" />
											Revoke
										</AlertDialogTrigger>
										<AlertDialogContent>
											<AlertDialogHeader>
												<AlertDialogTitle>
													Revoke {apiKey.name ?? "this API key"}?
												</AlertDialogTitle>
												<AlertDialogDescription>
													Any script or CLI using this key will stop working
													immediately. This cannot be undone.
												</AlertDialogDescription>
											</AlertDialogHeader>
											<AlertDialogFooter>
												<AlertDialogCancel>Cancel</AlertDialogCancel>
												<AlertDialogAction
													variant="destructive"
													onClick={() => void handleRevoke(apiKey)}
													disabled={revokingId === apiKey.id}
												>
													{revokingId === apiKey.id ? "Revoking..." : "Revoke"}
												</AlertDialogAction>
											</AlertDialogFooter>
										</AlertDialogContent>
									</AlertDialog>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
