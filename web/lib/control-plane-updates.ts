import { getSetting, setSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

const GITHUB_LATEST_RELEASE_URL =
	"https://api.github.com/repos/techulus/cloud/releases/latest";

type GitHubRelease = {
	tag_name?: string;
	html_url?: string;
	body?: string;
};

type ParsedVersion = {
	major: number;
	minor: number;
	patch: number;
	prerelease: string | null;
};

export type ControlPlaneUpdateState = {
	currentVersion: string;
	latestVersion: string | null;
	updateAvailable: boolean;
	releaseUrl: string | null;
	releaseNotes: string | null;
	checkedAt: string;
	channel: "release" | "rolling" | "unknown";
	error?: string;
};

export type ControlPlaneUpgradeState = {
	status: "idle" | "running" | "succeeded" | "failed";
	targetVersion: string | null;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	logs: string[];
};

export function getCurrentControlPlaneVersion() {
	return (
		process.env.TECHULUS_CLOUD_VERSION ||
		process.env.NEXT_PUBLIC_APP_VERSION ||
		"dev"
	);
}

function parseVersion(version: string): ParsedVersion | null {
	const match = version
		.trim()
		.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
	if (!match) return null;

	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ?? null,
	};
}

function isGreaterVersion(a: string, b: string) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	if (!left || !right) return false;

	if (left.major !== right.major) return left.major > right.major;
	if (left.minor !== right.minor) return left.minor > right.minor;
	if (left.patch !== right.patch) return left.patch > right.patch;

	if (left.prerelease === right.prerelease) return false;
	if (left.prerelease === null) return true;
	if (right.prerelease === null) return false;
	return left.prerelease > right.prerelease;
}

function getChannel(version: string): ControlPlaneUpdateState["channel"] {
	const normalized = version.trim().toLowerCase();
	if (normalized === "tip" || normalized === "dev" || normalized === "latest") {
		return "rolling";
	}
	return parseVersion(version) ? "release" : "unknown";
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
	const headers: HeadersInit = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "techulus-cloud-control-plane",
	};

	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
		headers,
		cache: "no-store",
	});

	if (!response.ok) {
		throw new Error(`GitHub release check failed (${response.status})`);
	}

	return response.json();
}

export async function checkControlPlaneUpdate(): Promise<ControlPlaneUpdateState> {
	const currentVersion = getCurrentControlPlaneVersion();
	const checkedAt = new Date().toISOString();
	const channel = getChannel(currentVersion);

	if (channel !== "release") {
		return {
			currentVersion,
			latestVersion: null,
			updateAvailable: false,
			releaseUrl: null,
			releaseNotes: null,
			checkedAt,
			channel,
		};
	}

	try {
		const release = await fetchLatestRelease();
		const latestVersion = release.tag_name ?? null;

		return {
			currentVersion,
			latestVersion,
			updateAvailable: latestVersion
				? isGreaterVersion(latestVersion, currentVersion)
				: false,
			releaseUrl: release.html_url ?? null,
			releaseNotes: release.body ?? null,
			checkedAt,
			channel,
		};
	} catch (error) {
		return {
			currentVersion,
			latestVersion: null,
			updateAvailable: false,
			releaseUrl: null,
			releaseNotes: null,
			checkedAt,
			channel,
			error: error instanceof Error ? error.message : "Failed to check updates",
		};
	}
}

export async function checkAndPersistControlPlaneUpdate() {
	const [previousState, nextState] = await Promise.all([
		getSetting<ControlPlaneUpdateState>(
			SETTING_KEYS.CONTROL_PLANE_UPDATE_STATE,
		),
		checkControlPlaneUpdate(),
	]);
	const state =
		nextState.error && previousState
			? {
					...previousState,
					currentVersion: nextState.currentVersion,
					updateAvailable: previousState.latestVersion
						? isGreaterVersion(
								previousState.latestVersion,
								nextState.currentVersion,
							)
						: false,
					checkedAt: nextState.checkedAt,
					channel: nextState.channel,
					error: nextState.error,
				}
			: nextState;
	await Promise.all([
		setSetting(SETTING_KEYS.CONTROL_PLANE_UPDATE_STATE, state),
		setSetting(
			SETTING_KEYS.CONTROL_PLANE_LAST_UPDATE_CHECK_AT,
			state.checkedAt,
		),
	]);
	return state;
}

function getUpdaterConfig() {
	const url = process.env.CONTROL_PLANE_UPDATER_URL;
	const token = process.env.CONTROL_PLANE_UPDATER_TOKEN;
	if (!url || !token) {
		throw new Error("Control plane updater is not configured");
	}
	return { url: url.replace(/\/$/, ""), token };
}

async function fetchUpdaterStatus(): Promise<ControlPlaneUpgradeState> {
	const { url, token } = getUpdaterConfig();
	const response = await fetch(`${url}/status`, {
		headers: { Authorization: `Bearer ${token}` },
		cache: "no-store",
	});
	if (!response.ok) {
		throw new Error(`Updater status request failed (${response.status})`);
	}
	return response.json();
}

async function postUpdaterUpgrade(
	targetVersion: string,
): Promise<ControlPlaneUpgradeState> {
	const { url, token } = getUpdaterConfig();
	const response = await fetch(`${url}/upgrade`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ targetVersion }),
	});

	const body = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			body?.error ?? `Updater request failed (${response.status})`,
		);
	}
	return body;
}

export async function startControlPlaneUpgrade(targetVersion: string) {
	const updateState = await getSetting<ControlPlaneUpdateState>(
		SETTING_KEYS.CONTROL_PLANE_UPDATE_STATE,
	);
	if (
		!updateState?.updateAvailable ||
		updateState.latestVersion !== targetVersion
	) {
		throw new Error("Target version is not the latest available release");
	}

	const upgradeState = await postUpdaterUpgrade(targetVersion);
	await setSetting(SETTING_KEYS.CONTROL_PLANE_UPGRADE_STATE, upgradeState);
	return upgradeState;
}

export async function refreshControlPlaneUpgradeState() {
	const upgradeState = await fetchUpdaterStatus();
	await setSetting(SETTING_KEYS.CONTROL_PLANE_UPGRADE_STATE, upgradeState);
	return upgradeState;
}
