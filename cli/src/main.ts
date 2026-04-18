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

type JsonRequestOptions = {
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
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
  tcloud link [--force]
  tcloud apply
  tcloud deploy
  tcloud status`);
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
		throw new Error("tcloud link requires an interactive terminal.");
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
	console.log("Open the verification URL in your browser to continue.");

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

async function commandLink(cwd: string, args: string[]) {
	const config = await requireConfig();
	const manifestPath = path.join(cwd, "techulus.yml");
	const force = args.includes("--force");

	if ((await pathExists(manifestPath)) && !force) {
		throw new Error(
			"techulus.yml already exists. Run `tcloud link --force` to replace it.",
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

	console.log(
		`Linked ${result.service.project}/${result.service.environment}/${result.service.name}`,
	);
	console.log(`Wrote ${manifestPath}`);
	console.log("Next: run `tcloud status` or `tcloud apply`.");
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
		case "link":
			await commandLink(cwd, rest);
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
