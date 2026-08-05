import type { ErrorEvent } from "@sentry/nextjs";

const REDACTED = "[REDACTED]";

const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
	String.raw`\b(DATABASE_URL|BETTER_AUTH_SECRET|ENCRYPTION_KEY|CONTROL_PLANE_UPDATER_TOKEN|REGISTRY_PASSWORD|REGISTRY_HTTP_SECRET|INNGEST_SIGNING_KEY|INNGEST_EVENT_KEY|GITHUB_APP_PRIVATE_KEY|GITHUB_WEBHOOK_SECRET|BACKUP_STORAGE_ACCESS_KEY|BACKUP_STORAGE_SECRET_KEY|SMTP_PASSWORD|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AGENT_TOKEN|REGISTRATION_TOKEN|VM_PASSWORD|VL_PASSWORD|SENTRY_DSN|password|secret|token|private[_ -]?key|access[_ -]?key|database[_ -]?url)\b(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)`,
	"gi",
);

const CREDENTIAL_URL_PATTERN =
	/\b([a-z][a-z\d+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const SENSITIVE_KEY_PARTS = [
	"authorization",
	"cookie",
	"password",
	"secret",
	"token",
	"privatekey",
	"accesskey",
	"databaseurl",
	"dsn",
];

function redactText(value: string) {
	return value
		.replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}:${REDACTED}@`)
		.replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
		.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`);
}

function isSensitiveKey(key: string) {
	const normalized = key.replace(/[^a-z\d]/gi, "").toLowerCase();
	return SENSITIVE_KEY_PARTS.some(
		(part) => normalized === part || normalized.endsWith(part),
	);
}

function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (!value || typeof value !== "object") return value;

	return Object.fromEntries(
		Object.entries(value).map(([key, nestedValue]) => [
			key,
			key === "sdkProcessingMetadata"
				? nestedValue
				: isSensitiveKey(key)
					? REDACTED
					: redactValue(nestedValue),
		]),
	);
}

export function redactSentryEvent(event: ErrorEvent): ErrorEvent {
	return redactValue(event) as ErrorEvent;
}
