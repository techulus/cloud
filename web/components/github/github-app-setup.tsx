"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
	Github,
	TriangleAlert,
	ExternalLink,
	Copy,
	RotateCcw,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const HOSTNAME_KEY = "techulus_github_hostname";
const STORAGE_TTL = 10 * 60 * 1000;

type GitHubCredentials = {
	id: string;
	slug: string;
	pem: string;
	webhookSecret: string;
	ownerType?: string;
	ownerLogin?: string;
};

function getStoredHostname(): string {
	if (typeof window === "undefined") return "";
	const item = sessionStorage.getItem(HOSTNAME_KEY);
	if (!item) return "";
	try {
		const { value, expires } = JSON.parse(item);
		if (Date.now() > expires) {
			sessionStorage.removeItem(HOSTNAME_KEY);
			return "";
		}
		return value;
	} catch {
		return "";
	}
}

function setStoredHostname(value: string) {
	const item = { value, expires: Date.now() + STORAGE_TTL };
	sessionStorage.setItem(HOSTNAME_KEY, JSON.stringify(item));
}

export function GitHubAppSetup() {
	const searchParams = useSearchParams();
	const router = useRouter();

	const [hostname, setHostname] = useState("");
	const [useOrg, setUseOrg] = useState(false);
	const [orgId, setOrgId] = useState("");
	const [credentials, setCredentials] = useState<GitHubCredentials | null>(
		null,
	);
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		const storedHostname = getStoredHostname();
		if (storedHostname) {
			setHostname(storedHostname);
		}

		const credentialsParam = searchParams.get("github_credentials");
		const errorParam = searchParams.get("github_error");

		if (credentialsParam) {
			try {
				const parsed = JSON.parse(decodeURIComponent(credentialsParam));
				setCredentials(parsed);
				setLoading(false);
			} catch {
				toast.error("Failed to parse GitHub credentials");
			}
			router.replace("/dashboard/settings?tab=github", { scroll: false });
		}

		if (errorParam) {
			const messages: Record<string, string> = {
				missing_code: "GitHub did not return an authorization code",
				conversion_failed:
					"Failed to exchange code for credentials. The code may have expired.",
				unknown: "An unknown error occurred",
			};
			toast.error(messages[errorParam] || "GitHub setup failed");
			setLoading(false);
			router.replace("/dashboard/settings?tab=github", { scroll: false });
		}
	}, [searchParams, router]);

	const isHostnameValid = (() => {
		const h = hostname.trim().toLowerCase();
		if (!h) return false;
		if (h === "localhost") return true;
		return /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(h);
	})();

	const isOrgValid =
		!useOrg || /^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$/i.test(orgId.trim());

	const canSubmit = isHostnameValid && isOrgValid && !loading;

	const githubUrl =
		useOrg && orgId.trim()
			? `https://github.com/organizations/${orgId.trim()}/settings/apps/new`
			: "https://github.com/settings/apps/new";

	const generateManifest = () => {
		const h = hostname.trim().toLowerCase();
		const protocol =
			h === "localhost" || h.endsWith(".local") ? "http" : "https";
		const appBaseUrl = `${protocol}://${h}`;
		const callbackUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/github/manifest/callback`;
		const appName = `techulus-cloud-${useOrg && orgId ? orgId.trim() : Math.random().toString(36).substring(2, 8)}`;

		return JSON.stringify({
			name: appName,
			url: appBaseUrl,
			hook_attributes: {
				url:
					h === "localhost"
						? "http://example.com/api/webhooks/github"
						: `${appBaseUrl}/api/webhooks/github`,
				active: true,
			},
			redirect_url: callbackUrl,
			callback_urls: [
				`${appBaseUrl}/api/github/authorize/callback`,
				`${appBaseUrl}/auth/github/callback`,
			],
			setup_url: `${appBaseUrl}/api/github/setup`,
			setup_on_update: true,
			public: true,
			default_permissions: {
				administration: "write",
				checks: "write",
				contents: "write",
				deployments: "write",
				issues: "write",
				metadata: "read",
				pull_requests: "write",
				repository_hooks: "write",
				statuses: "write",
				emails: "read",
			},
			default_events: ["installation_target", "push", "repository"],
		});
	};

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		if (!canSubmit) {
			e.preventDefault();
			return;
		}
		setStoredHostname(hostname.trim().toLowerCase());
	};

	const envOutput = credentials
		? `GITHUB_APP_ID="${credentials.id}"
GITHUB_APP_PRIVATE_KEY="${credentials.pem}"
GITHUB_WEBHOOK_SECRET="${credentials.webhookSecret}"`
		: "";

	const githubAppUrl = credentials
		? credentials.ownerType === "Organization"
			? `https://github.com/organizations/${credentials.ownerLogin}/settings/apps/${credentials.slug}`
			: `https://github.com/settings/apps/${credentials.slug}`
		: "";

	const copyToClipboard = async () => {
		try {
			await navigator.clipboard.writeText(envOutput);
			setCopied(true);
			toast.success("Copied to clipboard");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy to clipboard");
		}
	};

	const reset = () => {
		setCredentials(null);
		setHostname("");
		setOrgId("");
		setUseOrg(false);
		setCopied(false);
		setLoading(false);
		sessionStorage.removeItem(HOSTNAME_KEY);
	};

	const isLocalhost = hostname.trim().toLowerCase() === "localhost";

	if (credentials || loading) {
		return (
			<div className="rounded-lg border">
				<Item className="border-0 border-b rounded-none">
					<ItemMedia variant="icon">
						<Github className="size-5 text-muted-foreground" />
					</ItemMedia>
					<ItemContent>
						<ItemTitle>GitHub App Credentials</ItemTitle>
					</ItemContent>
				</Item>
				<div className="p-4 space-y-4">
					<p className="text-sm text-muted-foreground">
						Copy the following environment variables into your{" "}
						<code className="bg-muted px-1 rounded">.env</code> file.
					</p>

					{loading && (
						<div className="h-48 flex items-center justify-center border rounded-md bg-muted/30">
							<span className="text-muted-foreground">
								Retrieving credentials...
							</span>
						</div>
					)}

					{!loading && credentials && (
						<>
							{isLocalhost && (
								<Alert>
									<TriangleAlert className="size-4" />
									<AlertTitle>Update webhook URL</AlertTitle>
									<AlertDescription>
										The webhook URL was set to a placeholder because GitHub
										cannot reach localhost. Use a tunnel (e.g., ngrok) and{" "}
										<a
											href={githubAppUrl}
											target="_blank"
											rel="noopener noreferrer"
											className="underline"
										>
											update the webhook URL in the GitHub App settings
										</a>
										.
									</AlertDescription>
								</Alert>
							)}

							<textarea
								className="w-full h-48 p-3 font-mono text-sm border rounded-md bg-muted/30 resize-none"
								value={envOutput}
								readOnly
							/>
						</>
					)}

					<div className="flex items-center justify-between pt-2">
						<Button variant="ghost" onClick={reset} disabled={loading}>
							<RotateCcw className="size-4 mr-2" />
							Reset
						</Button>
						<div className="flex items-center gap-2">
							{githubAppUrl && (
								<a
									href={githubAppUrl}
									target="_blank"
									rel="noopener noreferrer"
									title="View on GitHub"
									className={buttonVariants({
										variant: "outline",
										size: "icon",
									})}
								>
									<ExternalLink className="size-4" />
								</a>
							)}
							<Button onClick={copyToClipboard} disabled={loading || copied}>
								<Copy className="size-4 mr-2" />
								{copied ? "Copied!" : "Copy to clipboard"}
							</Button>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-lg border">
			<Item className="border-0 border-b rounded-none">
				<ItemMedia variant="icon">
					<Github className="size-5 text-muted-foreground" />
				</ItemMedia>
				<ItemContent>
					<ItemTitle>Create GitHub App</ItemTitle>
				</ItemContent>
			</Item>
			<div className="p-4 space-y-4">
				<p className="text-sm text-muted-foreground">
					Create a GitHub App to enable repository access and webhook
					integration. You will be redirected to GitHub to confirm, then back
					here to copy the configuration. You must be logged into GitHub before
					creating the app.
				</p>

				<form
					method="POST"
					action={githubUrl}
					onSubmit={handleSubmit}
					className="space-y-4"
				>
					<input type="hidden" name="manifest" value={generateManifest()} />

					<div className="space-y-2">
						<Label htmlFor="hostname">App hostname</Label>
						<Input
							type="text"
							id="hostname"
							value={hostname}
							onChange={(e) => setHostname(e.target.value)}
							placeholder="e.g., cloud.example.com"
							required
						/>
						<p className="text-xs text-muted-foreground">
							Enter the domain without{" "}
							<code className="bg-muted px-1 rounded">https://</code>
						</p>
					</div>

					<div className="flex items-center gap-3">
						<Switch
							id="use-org"
							checked={useOrg}
							onCheckedChange={(checked) => {
								setUseOrg(checked);
								if (!checked) setOrgId("");
							}}
						/>
						<Label htmlFor="use-org" className="cursor-pointer">
							Use organization account
						</Label>
					</div>

					{useOrg && (
						<div className="space-y-2">
							<Label htmlFor="org-id">Organization ID</Label>
							<Input
								type="text"
								id="org-id"
								value={orgId}
								onChange={(e) => setOrgId(e.target.value)}
								placeholder="e.g., acme-inc"
								required={useOrg}
							/>
							<p className="text-xs text-muted-foreground">
								Find this on your organization's GitHub settings page.
							</p>
						</div>
					)}

					<div className="pt-2">
						<Button type="submit" disabled={!canSubmit}>
							<Github className="size-4 mr-2" />
							Create GitHub App
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
