import { access, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { deleteConfig, readConfig, writeConfig } from "./config.js";
import { loadManifest, slugify, type TechulusManifest } from "./manifest.js";

const CLI_VERSION = "0.1.0";
const CLI_CLIENT_ID = "techulus-cli";

type JsonRequestOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

function normalizeHost(host: string) {
	const trimmed = host.trim().replace(/\/$/, "");
	if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
		return `https://${trimmed}`;
	}

	return trimmed;
}

async function requestJson<T>(url: string, options: JsonRequestOptions = {}) {
	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: {
			"content-type": "application/json",
			...(options.headers ?? {}),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});

	const text = await response.text();
	const data = text ? (JSON.parse(text) as T | { error?: string }) : null;

	if (!response.ok) {
		const message =
			data && typeof data === "object" && "error" in data && data.error
				? data.error
				: `Request failed with ${response.status}`;
		throw new Error(message);
	}

	return data as T;
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOption(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index === -1) {
		return null;
	}

	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new Error(`Missing value for ${name}`);
	}

	return value;
}

function printUsage() {
	console.log(`Usage:
  tcloud auth login --host <url>
  tcloud auth logout
  tcloud auth whoami
  tcloud init
  tcloud apply
  tcloud deploy
  tcloud status`);
}

function openBrowser(url: string) {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "cmd"
				: "xdg-open";
	const args =
		process.platform === "win32" ? ["/c", "start", "", url] : [url];

	const child = spawn(command, args, {
		detached: true,
		stdio: "ignore",
	});

	child.unref();
}

async function ensureManifest(cwd: string) {
	try {
		return await loadManifest(cwd);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(
				"No techulus.yml found in the current directory. Run `tcloud init` to create one.",
			);
		}
		throw new Error(
			error instanceof Error
				? `Invalid techulus.yml: ${error.message}`
				: "Failed to load techulus.yml",
		);
	}
}

function authHeaders(apiKey: string) {
	return {
		"x-api-key": apiKey,
	};
}

async function requireConfig() {
	const config = await readConfig();
	if (!config) {
		throw new Error("Not logged in. Run `tcloud auth login --host <url>` first.");
	}

	return config;
}

async function commandAuthLogin(args: string[]) {
	const existingConfig = await readConfig();
	const rawHost = parseOption(args, "--host") ?? existingConfig?.host;

	if (!rawHost) {
		throw new Error("Missing --host");
	}

	const host = normalizeHost(rawHost);

	const deviceCode = await requestJson<{
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete: string;
		expires_in: number;
		interval: number;
	}>(`${host}/api/auth/device/code`, {
		method: "POST",
		body: {
			client_id: CLI_CLIENT_ID,
			scope: "cli",
		},
	});

	console.log(`Visit ${deviceCode.verification_uri}`);
	console.log(`Enter code: ${deviceCode.user_code}`);

	try {
		openBrowser(deviceCode.verification_uri_complete || deviceCode.verification_uri);
		console.log("Opened your browser for approval.");
	} catch {
		console.log("Could not open the browser automatically.");
	}

	let accessToken = "";
	let intervalMs = deviceCode.interval * 1000;

	while (!accessToken) {
		await sleep(intervalMs);

		const response = await fetch(`${host}/api/auth/device/token`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: deviceCode.device_code,
				client_id: CLI_CLIENT_ID,
			}),
		});

		const data = (await response.json()) as
			| {
					access_token: string;
			  }
			| {
					error: string;
					error_description?: string;
			  };

		if (response.ok && "access_token" in data) {
			accessToken = data.access_token;
			break;
		}

		if (!("error" in data)) {
			throw new Error("Unexpected response from device token endpoint");
		}

		switch (data.error) {
			case "authorization_pending":
				process.stdout.write(".");
				break;
			case "slow_down":
				intervalMs += 5000;
				break;
			case "access_denied":
				throw new Error(data.error_description || "Device authorization was denied");
			case "expired_token":
				throw new Error(data.error_description || "Device authorization expired");
			default:
				throw new Error(data.error_description || data.error);
		}
	}

	console.log("\nDevice login approved. Creating a CLI API key...");

	const machineName = os.hostname();
	const platform = `${process.platform}/${process.arch}`;
	const exchange = await requestJson<{
		apiKey: string;
		keyId: string;
		name: string | null;
		user: { id: string; email: string; name: string };
	}>(`${host}/api/v1/cli/auth/exchange`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
		},
		body: {
			machineName,
			platform,
			cliVersion: CLI_VERSION,
		},
	});

	await writeConfig({
		host,
		apiKey: exchange.apiKey,
		keyId: exchange.keyId,
		keyName: exchange.name,
		user: exchange.user,
	});

	console.log(`Signed in as ${exchange.user.email}`);
}

async function commandAuthLogout() {
	await deleteConfig();
	console.log("Signed out.");
}

async function commandAuthWhoAmI() {
	const config = await requireConfig();
	const whoami = await requestJson<{
		user: { id: string; email: string; name: string };
	}>(`${config.host}/api/v1/cli/auth/whoami`, {
		headers: authHeaders(config.apiKey),
	});

	console.log(`Signed in as ${whoami.user.email}`);
	console.log(`Name: ${whoami.user.name}`);
	console.log(`Host: ${config.host}`);
}

async function commandInit(cwd: string) {
	const manifestPath = path.join(cwd, "techulus.yml");
	try {
		await access(manifestPath, fsConstants.F_OK);
		throw new Error("techulus.yml already exists");
	} catch (error) {
		if (error instanceof Error && error.message === "techulus.yml already exists") {
			throw error;
		}
	}

	const folderName = slugify(path.basename(cwd)) || "my-service";
	const manifest = `apiVersion: v1
project: ${folderName}
environment: production
service:
  name: ${folderName}
  source:
    type: image
    image: nginx:latest
  replicas:
    count: 1
  ports:
    - port: 80
      public: false
`;

	await writeFile(manifestPath, manifest, "utf8");
	console.log(`Created ${manifestPath}`);
}

function printApplyResult(result: {
	action: "created" | "updated" | "noop";
	serviceId: string;
	changes: Array<{ field: string; from: string; to: string }>;
}) {
	console.log(`Action: ${result.action}`);
	console.log(`Service ID: ${result.serviceId}`);

	if (result.changes.length === 0) {
		console.log("No changes.");
		return;
	}

	console.log("Changes:");
	for (const change of result.changes) {
		console.log(`- ${change.field}: ${change.from} -> ${change.to}`);
	}
}

async function commandApply(cwd: string) {
	const config = await requireConfig();
	const { manifest } = await ensureManifest(cwd);
	const result = await requestJson<{
		action: "created" | "updated" | "noop";
		serviceId: string;
		changes: Array<{ field: string; from: string; to: string }>;
	}>(`${config.host}/api/v1/manifest/apply`, {
		method: "POST",
		headers: authHeaders(config.apiKey),
		body: manifest,
	});

	printApplyResult(result);
}

async function commandDeploy(cwd: string) {
	const config = await requireConfig();
	const { manifest } = await ensureManifest(cwd);
	const result = await requestJson<{
		serviceId: string;
		rolloutId: string | null;
		status: string;
	}>(`${config.host}/api/v1/manifest/deploy`, {
		method: "POST",
		headers: authHeaders(config.apiKey),
		body: manifest,
	});

	console.log(`Service ID: ${result.serviceId}`);
	console.log(`Status: ${result.status}`);
	if (result.rolloutId) {
		console.log(`Rollout ID: ${result.rolloutId}`);
	}
}

async function commandStatus(cwd: string) {
	const config = await requireConfig();
	const { manifest } = await ensureManifest(cwd);
	const params = new URLSearchParams({
		project: manifest.project,
		environment: manifest.environment,
		service: manifest.service.name,
	});
	const status = await requestJson<{
		service: {
			id: string;
			image: string;
			hostname: string | null;
			replicas: number;
		};
		latestRollout: {
			id: string;
			status: string;
			currentStage: string | null;
		} | null;
		deployments: Array<{
			id: string;
			status: string;
			serverId: string;
		}>;
	}>(`${config.host}/api/v1/manifest/status?${params.toString()}`, {
		headers: authHeaders(config.apiKey),
	});

	console.log(`Service ID: ${status.service.id}`);
	console.log(`Image: ${status.service.image}`);
	console.log(`Hostname: ${status.service.hostname ?? "(none)"}`);
	console.log(`Replicas: ${status.service.replicas}`);
	if (status.latestRollout) {
		console.log(
			`Latest rollout: ${status.latestRollout.id} (${status.latestRollout.status}${status.latestRollout.currentStage ? `, ${status.latestRollout.currentStage}` : ""})`,
		);
	} else {
		console.log("Latest rollout: none");
	}
	console.log(`Deployments: ${status.deployments.length}`);
	for (const deployment of status.deployments) {
		console.log(`- ${deployment.id}: ${deployment.status} on ${deployment.serverId}`);
	}
}

async function main() {
	const [command, subcommand, ...rest] = process.argv.slice(2);
	const cwd = process.cwd();

	if (!command) {
		printUsage();
		return;
	}

	switch (command) {
		case "auth":
			switch (subcommand) {
				case "login":
					await commandAuthLogin(rest);
					return;
				case "logout":
					await commandAuthLogout();
					return;
				case "whoami":
					await commandAuthWhoAmI();
					return;
				default:
					printUsage();
					return;
			}
		case "init":
			await commandInit(cwd);
			return;
		case "apply":
			await commandApply(cwd);
			return;
		case "deploy":
			await commandDeploy(cwd);
			return;
		case "status":
			await commandStatus(cwd);
			return;
		default:
			printUsage();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "Unknown error");
	process.exit(1);
});
