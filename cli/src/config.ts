import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CliConfig = {
	host: string;
	apiKey: string;
	keyId?: string;
	keyName?: string | null;
	user?: {
		id: string;
		email: string;
		name: string;
	};
};

function getConfigRoot() {
	if (process.env.XDG_CONFIG_HOME) {
		return process.env.XDG_CONFIG_HOME;
	}

	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Application Support");
	}

	if (process.platform === "win32" && process.env.APPDATA) {
		return process.env.APPDATA;
	}

	return path.join(os.homedir(), ".config");
}

export function getConfigDir() {
	return path.join(getConfigRoot(), "techulus-cloud-cli");
}

export function getConfigPath() {
	return path.join(getConfigDir(), "config.json");
}

export async function readConfig(): Promise<CliConfig | null> {
	try {
		const contents = await readFile(getConfigPath(), "utf8");
		return JSON.parse(contents) as CliConfig;
	} catch {
		return null;
	}
}

export async function writeConfig(config: CliConfig) {
	const dir = getConfigDir();
	const file = getConfigPath();

	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(file, JSON.stringify(config, null, 2), {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmod(file, 0o600);
}

export async function deleteConfig() {
	await rm(getConfigPath(), { force: true });
}
