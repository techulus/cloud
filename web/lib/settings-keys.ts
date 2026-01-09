export const SETTING_KEYS = {
	SERVERS_ALLOWED_FOR_BUILDS: "servers_allowed_for_builds",
	SERVERS_EXCLUDED_FROM_WORKLOAD_PLACEMENT:
		"servers_excluded_from_workload_placement",
	BUILD_TIMEOUT_MINUTES: "build_timeout_minutes",
} as const;

export const DEFAULT_BUILD_TIMEOUT_MINUTES = 30;
