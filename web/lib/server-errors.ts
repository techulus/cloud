import * as Sentry from "@sentry/nextjs";

type SafeMetadataValue = string | number | boolean | null;
const MAX_REASON_LENGTH = 500;

type ReportingContext = {
	tags?: Record<string, Exclude<SafeMetadataValue, null>>;
	extra?: Record<string, SafeMetadataValue>;
};

type OperationFailureContext = ReportingContext & {
	occurrenceId: string;
	reason?: string;
};

export function reportServerError(
	error: unknown,
	operation: string,
	context: ReportingContext = {},
) {
	return Sentry.captureException(error, {
		tags: { operation, ...context.tags },
		extra: context.extra,
	});
}

export function reportOperationFailure(
	operation: string,
	{ occurrenceId, reason, tags, extra }: OperationFailureContext,
) {
	const safeReason = reason
		// eslint-disable-next-line no-control-regex -- Strip unsafe control characters from reported reasons.
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.slice(0, MAX_REASON_LENGTH);
	return Sentry.captureMessage(`Business operation failed: ${operation}`, {
		level: "error",
		fingerprint: ["business-failure", operation],
		tags: { operation, ...tags },
		extra: {
			...extra,
			occurrenceId,
			...(safeReason ? { reason: safeReason } : {}),
		},
	});
}
