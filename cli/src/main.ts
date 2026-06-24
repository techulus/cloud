import { access, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { deleteConfig, readConfig, writeConfig } from "./config.js";
import {
	loadManifest,
	slugify,
	stringifyManifest,
	type TechulusManifest,
} from "./manifest.js";

const CLI_VERSION = "0.1.0";
const CLI_CLIENT_ID = "techulus-cli";
const DEFAULT_LOG_TAIL = 100;
const LOG_POLL_INTERVAL_MS = 2000;

type JsonRequestOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

type ErrorResponse = {
	error?: string;
	message?: string;
	code?: string;
};

type LinkServiceTarget = {
	id: string;
	name: string;
	project: string;
	environment: string;
	linkSupported: boolean;
	unsupportedReason: string | null;
};

type LinkEnvironmentTarget = {
	id: string;
	name: string;
	services: LinkServiceTarget[];
};

type LinkProjectTarget = {
	id: string;
	name: string;
	slug: string;
	environments: LinkEnvironmentTarget[];
};

type ServiceLog = {
	deploymentId: string | undefined;
	stream: string;
	message: string;
	timestamp: string;
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
	const data = text ? (JSON.parse(text) as T | ErrorResponse) : null;

	if (!response.ok) {
		const apiMessage =
			data && typeof data === "object"
				? "message" in data && data.message
					? data.message
					: "error" in data && data.error
						? data.error
						: null
				: null;
		const code =
			data && typeof data === "object" && "code" in data && data.code
				? ` (${data.code})`
				: "";
		const message = apiMessage
			? `${apiMessage}${code}`
			: `Request failed with ${response.status}`;

		if (response.status === 401 || response.status === 403) {
			const host = normalizeHost(new URL(url).origin);
			throw new Error(
				`${message}\n\nYour CLI session is not authorized. Run:\n  tc auth login --host ${host}`,
			);
		}

		throw new Error(message);
	}

	return data as T;
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortId(id: string) {
	if (id.length <= 16) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function formatStatus(value: string) {
	return value.replace(/_/g, " ");
}

function formatTimestamp(value: string) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString();
}

function printSection(title: string) {
	console.log(`\n${title}`);
	console.log("─".repeat(title.length));
}

function printField(label: string, value: string | number) {
	console.log(`  ${label.padEnd(10)} ${value}`);
}

function printNext(command: string) {
	printSection("Next");
	printField("Run", command);
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

function parseLogLineLimit(args: string[]) {
	const rawTail = parseOption(args, "-n") ?? parseOption(args, "--tail");
	if (!rawTail) return null;

	if (!/^\d+$/.test(rawTail)) {
		throw new Error("log line count must be a positive integer");
	}

	const tail = Number.parseInt(rawTail, 10);
	if (tail < 1 || tail > 1000) {
		throw new Error("log line count must be between 1 and 1000");
	}

	return tail;
}

function printUsage() {
	console.log(`Usage:
  tc auth login --host <url>
  tc auth logout
  tc auth whoami
  tc init
  tc link [--force]
  tc apply
  tc deploy
  tc logs
  tc logs -n <n>
  tc status`);
}

async function pathExists(filePath: string) {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function countSupportedServices(projects: LinkProjectTarget[]) {
	return projects.reduce(
		(total, project) =>
			total +
			project.environments.reduce(
				(environmentTotal, environment) =>
					environmentTotal +
					environment.services.filter((service) => service.linkSupported).length,
				0,
			),
		0,
	);
}

async function selectFromList<T>(
	title: string,
	items: T[],
	renderItem: (item: T, index: number) => string,
	getDisabledReason?: (item: T) => string | null,
) {
	if (items.length === 0) {
		throw new Error(`No options available for "${title}"`);
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("tc link requires an interactive terminal.");
	}

	const rl = createInterface({ input, output });

	try {
		while (true) {
			console.log(`\n${title}`);
			for (const [index, item] of items.entries()) {
				console.log(`  ${index + 1}. ${renderItem(item, index)}`);
			}

			const answer = (await rl.question("> ")).trim();
			const choice = Number.parseInt(answer, 10);

			if (!Number.isInteger(choice) || choice < 1 || choice > items.length) {
				console.log("Enter the number of the option you want.");
				continue;
			}

			const selected = items[choice - 1];
			const disabledReason = getDisabledReason?.(selected) ?? null;

			if (disabledReason) {
				console.log(disabledReason);
				continue;
			}

			return selected;
		}
	} finally {
		rl.close();
	}
}

async function ensureManifest(cwd: string) {
	try {
		return await loadManifest(cwd);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(
				"No techulus.yml found in the current directory. Run `tc init` to create one.",
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
		throw new Error("Not logged in. Run `tc auth login --host <url>` first.");
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

	const verificationUrl =
		deviceCode.verification_uri_complete || deviceCode.verification_uri;

	printSection("Device login");
	printField("Host", host);
	printField("URL", verificationUrl);
	printField("Code", deviceCode.user_code);
	console.log("\nOpen the verification URL in your browser to continue.");

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

	console.log("\n\nDevice approved. Creating a CLI API key...");

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

	printSection("Signed in");
	printField("User", exchange.user.email);
	printField("Name", exchange.user.name);
	printField("Host", host);
	printField("Key", exchange.keyId ? shortId(exchange.keyId) : "created");
}

async function commandAuthLogout() {
	await deleteConfig();
	printSection("Signed out");
	printField("Config", "removed");
}

async function commandAuthWhoAmI() {
	const config = await requireConfig();
	const whoami = await requestJson<{
		user: { id: string; email: string; name: string };
	}>(`${config.host}/api/v1/cli/auth/whoami`, {
		headers: authHeaders(config.apiKey),
	});

	printSection("Account");
	printField("User", whoami.user.email);
	printField("Name", whoami.user.name);
	printField("Host", config.host);
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
    image: nginx:1.27
  replicas:
    count: 1
  resources:
    cpuCores: 2
    memoryMb: 1024
  ports:
    - port: 80
      public: false
`;

	await writeFile(manifestPath, manifest, "utf8");
	printSection("Manifest");
	printField("Created", manifestPath);
	printNext("tc apply");
}

async function commandLink(cwd: string, args: string[]) {
	const config = await requireConfig();
	const manifestPath = path.join(cwd, "techulus.yml");
	const force = args.includes("--force");

	if ((await pathExists(manifestPath)) && !force) {
		throw new Error(
			"techulus.yml already exists. Run `tc link --force` to replace it.",
		);
	}

	const targets = await requestJson<{ projects: LinkProjectTarget[] }>(
		`${config.host}/api/v1/manifest/link-targets`,
		{
			headers: authHeaders(config.apiKey),
		},
	);

	if (countSupportedServices(targets.projects) === 0) {
		throw new Error("No linkable services were found in your account.");
	}

	const projectChoices = targets.projects.filter(
		(project) =>
			project.environments.some((environment) => environment.services.length > 0),
	);
	if (projectChoices.length === 0) {
		throw new Error("No services were found in your account.");
	}

	const project = await selectFromList(
		"Select a project:",
		projectChoices,
		(project) => {
			const serviceCount = project.environments.reduce(
				(total, environment) => total + environment.services.length,
				0,
			);
			return `${project.name} (${serviceCount} service${serviceCount === 1 ? "" : "s"})`;
		},
	);

	const environmentChoices = project.environments.filter(
		(environment) => environment.services.length > 0,
	);
	const environment = await selectFromList(
		"Select an environment:",
		environmentChoices,
		(environment) => {
			const supportedCount = environment.services.filter(
				(service) => service.linkSupported,
			).length;
			return `${environment.name} (${supportedCount}/${environment.services.length} linkable)`;
		},
	);

	const service = await selectFromList(
		"Select a service:",
		environment.services,
		(service) =>
			service.linkSupported
				? service.name
				: `${service.name} (unsupported: ${service.unsupportedReason})`,
		(service) =>
			service.linkSupported
				? null
				: service.unsupportedReason ?? "This service can't be linked.",
	);

	const result = await requestJson<{
		manifest: TechulusManifest;
		service: {
			id: string;
			name: string;
			project: string;
			environment: string;
		};
	}>(`${config.host}/api/v1/manifest/link`, {
		method: "POST",
		headers: authHeaders(config.apiKey),
		body: {
			serviceId: service.id,
		},
	});

	await writeFile(manifestPath, stringifyManifest(result.manifest), "utf8");

	printSection("Linked");
	printField(
		"Service",
		`${result.service.project}/${result.service.environment}/${result.service.name}`,
	);
	printField("Manifest", manifestPath);
	printNext("tc status  or  tc apply");
}

function printApplyResult(result: {
	action: "created" | "updated" | "noop";
	serviceId: string;
	changes: Array<{ field: string; from: string; to: string }>;
}) {
	printSection("Apply");
	printField("Action", result.action);
	printField("Service", shortId(result.serviceId));

	if (result.changes.length === 0) {
		printField("Changes", "none");
		return;
	}

	printSection(`Changes (${result.changes.length})`);
	for (const change of result.changes) {
		console.log(`  • ${change.field}`);
		printField("From", change.from);
		printField("To", change.to);
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

	printSection("Deploy");
	printField("Service", shortId(result.serviceId));
	printField("Status", formatStatus(result.status));
	if (result.rolloutId) {
		printField("Rollout", shortId(result.rolloutId));
	}
	printNext("tc status");
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

	console.log(`${manifest.project}/${manifest.environment}/${manifest.service.name}`);

	printSection("Service");
	printField("ID", shortId(status.service.id));
	printField("Image", status.service.image);
	printField("Hostname", status.service.hostname ?? "none");
	printField("Replicas", status.service.replicas);

	printSection("Rollout");
	if (status.latestRollout) {
		printField("ID", shortId(status.latestRollout.id));
		printField("Status", formatStatus(status.latestRollout.status));
		printField(
			"Stage",
			status.latestRollout.currentStage
				? formatStatus(status.latestRollout.currentStage)
				: "none",
		);
	} else {
		printField("Latest", "none");
	}

	printSection(`Deployments (${status.deployments.length})`);
	if (status.deployments.length === 0) {
		printField("Current", "none");
		return;
	}

	for (const deployment of status.deployments) {
		console.log(`  • ${shortId(deployment.id)}`);
		printField("Status", formatStatus(deployment.status));
		printField("Server", shortId(deployment.serverId));
	}
}

function printLogs(logs: ServiceLog[]) {
	for (const log of logs) {
		const stream = `[${log.stream || "stdout"}]`.padEnd(9);
		const message = log.message.replace(/\n+$/, "");
		console.log(`${formatTimestamp(log.timestamp)} ${stream} ${message}`);
	}
}

function getLogCursor(logs: ServiceLog[]) {
	return logs.reduce<string | null>((latest, log) => {
		if (!latest) return log.timestamp;
		return new Date(log.timestamp).getTime() > new Date(latest).getTime()
			? log.timestamp
			: latest;
	}, null);
}

function getLogKey(log: ServiceLog) {
	return `${log.timestamp}:${log.stream}:${log.deploymentId ?? ""}:${log.message}`;
}

async function fetchManifestLogs(
	config: Awaited<ReturnType<typeof requireConfig>>,
	manifest: TechulusManifest,
	options: { tail: number; after?: string | null },
) {
	const params = new URLSearchParams({
		project: manifest.project,
		environment: manifest.environment,
		service: manifest.service.name,
		tail: String(options.tail),
	});
	if (options.after) {
		params.set("after", options.after);
	}

	return requestJson<{
		loggingEnabled: boolean;
		logs: ServiceLog[];
	}>(`${config.host}/api/v1/manifest/logs?${params.toString()}`, {
		headers: authHeaders(config.apiKey),
	});
}

async function commandLogs(cwd: string, args: string[]) {
	const lineLimit = parseLogLineLimit(args);
	const config = await requireConfig();
	const { manifest } = await ensureManifest(cwd);
	const result = await fetchManifestLogs(config, manifest, {
		tail: lineLimit ?? DEFAULT_LOG_TAIL,
	});

	console.log(`${manifest.project}/${manifest.environment}/${manifest.service.name}`);

	if (!result.loggingEnabled) {
		printSection("Logs");
		printField("Status", "disabled");
		return;
	}

	if (lineLimit && result.logs.length === 0) {
		printSection("Logs");
		printField("Lines", "none");
		return;
	}

	if (lineLimit) {
		printSection(`Logs (${result.logs.length})`);
		printLogs(result.logs);
		return;
	}

	printSection("Logs");
	if (result.logs.length > 0) {
		printLogs(result.logs);
	} else {
		printField("Waiting", "new log lines");
	}

	let after = getLogCursor(result.logs) ?? new Date().toISOString();
	const seen = new Set(result.logs.map(getLogKey));

	while (true) {
		await sleep(LOG_POLL_INTERVAL_MS);
		const next = await fetchManifestLogs(config, manifest, {
			tail: DEFAULT_LOG_TAIL,
			after,
		});
		const logs = next.logs.filter((log) => !seen.has(getLogKey(log)));
		if (logs.length === 0) continue;

		printLogs(logs);
		for (const log of logs) {
			seen.add(getLogKey(log));
		}
		after = getLogCursor(logs) ?? after;
	}
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv[0] === "--") {
		argv.shift();
	}

	const [command, subcommand, ...rest] = argv;
	const cwd = process.env.INIT_CWD || process.cwd();

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
		case "link":
			await commandLink(cwd, rest);
			return;
		case "apply":
			await commandApply(cwd);
			return;
		case "deploy":
			await commandDeploy(cwd);
			return;
		case "logs":
			await commandLogs(cwd, [subcommand, ...rest].filter(Boolean));
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
