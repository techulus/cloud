import * as http from "node:http";
import * as https from "node:https";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { db } from "@/db";
import { secrets, serviceCrons, services } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { notify } from "@/lib/notifications";
import { isSafeCronPath, nextOccurrenceAfter } from "@/lib/public-api";
import { ingestCronLog, type CronLog } from "@/lib/victoria-logs";

const MAX_ERROR = 500;
const EXECUTION_BUDGET_MS = 10_000;

export type CronRequestResult = {
	status: "succeeded" | "failed";
	statusCode: number | null;
	error: string | null;
};

export { nextOccurrenceAfter };

export function latestDueOccurrence(
	schedule: string,
	cursor: Date,
	now: Date,
): Date | null {
	try {
		const occurrence = CronExpressionParser.parse(schedule, {
			currentDate: new Date(now.getTime() + 1),
			tz: "UTC",
		})
			.prev()
			.toDate();
		return occurrence > cursor && occurrence <= now ? occurrence : null;
	} catch {
		return null;
	}
}

export function cronEventId(cronId: string, scheduledFor: Date): string {
	return `service-cron:${cronId}:${scheduledFor.toISOString()}`;
}

export function sanitizeCronError(error: unknown): string {
	const message =
		error instanceof Error ? error.message : "Cron request failed";
	// eslint-disable-next-line no-control-regex -- Strip unsafe control characters from persisted errors.
	return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR);
}

export function parseCronUrl(base: string, path: string): URL {
	if (!isSafeCronPath(path)) throw new Error("Invalid cron path");
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw new Error("Invalid CRON_BASE_URL");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error("Invalid CRON_BASE_URL");
	return new URL(path, `${url.origin}/`);
}

type RequestImpl = typeof http.request;
export function validateCronTransport(url: URL, secret?: string): void {
	if (secret && url.protocol === "http:")
		throw new Error("CRON_SECRET requires HTTPS");
}

export async function performCronGet(
	url: URL,
	secret: string | undefined,
	timeoutMs: number,
	requestImpl: RequestImpl = url.protocol === "https:"
		? https.request
		: http.request,
): Promise<CronRequestResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: CronRequestResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		if (timeoutMs <= 0)
			return finish({
				status: "failed",
				statusCode: null,
				error: "Cron request timed out",
			});
		const requestOptions: http.RequestOptions = {
			method: "GET",
			agent: false,
			headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
		};
		const req = requestImpl(url, requestOptions, (response) => {
			const code = response.statusCode ?? null;
			response.destroy();
			finish(
				code != null && code >= 200 && code < 300
					? { status: "succeeded", statusCode: code, error: null }
					: {
							status: "failed",
							statusCode: code,
							error: `HTTP status ${code ?? "unknown"}`,
						},
			);
		});
		const timer = setTimeout(() => {
			finish({
				status: "failed",
				statusCode: null,
				error: "Cron request timed out",
			});
			req.destroy();
		}, timeoutMs);
		timer.unref?.();
		req.once("error", () =>
			finish({
				status: "failed",
				statusCode: null,
				error: "Cron request failed",
			}),
		);
		req.once("close", () => {
			clearTimeout(timer);
			if (!settled)
				finish({
					status: "failed",
					statusCode: null,
					error: "Cron request closed",
				});
		});
		req.end();
	});
}
export async function executeServiceCron(
	cronId: string,
	schedule: string,
	scheduledFor: Date,
	source: "scheduled" | "manual",
) {
	const deadline = Date.now() + EXECUTION_BUDGET_MS;
	const row = await db
		.select({ cron: serviceCrons, serviceId: services.id })
		.from(serviceCrons)
		.innerJoin(
			services,
			and(eq(serviceCrons.serviceId, services.id), isNull(services.deletedAt)),
		)
		.where(eq(serviceCrons.id, cronId))
		.limit(1)
		.then((rows) => rows[0]);
	if (!row || row.cron.schedule !== schedule) return { stale: true as const };
	const startedAt = new Date();
	const claimed = await db
		.update(serviceCrons)
		.set({
			lastStartedAt: startedAt,
			...(source === "scheduled" ? { lastAttemptedFor: scheduledFor } : {}),
		})
		.where(
			and(
				eq(serviceCrons.id, cronId),
				eq(serviceCrons.schedule, schedule),
				source === "scheduled"
					? or(
							isNull(serviceCrons.lastAttemptedFor),
							lt(serviceCrons.lastAttemptedFor, scheduledFor),
						)
					: undefined,
			),
		)
		.returning({ id: serviceCrons.id });
	if (!claimed.length) return { stale: true as const };
	let status: "succeeded" | "failed" | "skipped" = "skipped";
	let statusCode: number | null = null;
	let error: string | null = null;
	let base = "";
	let secret: string | undefined;
	try {
		const values = await db
			.select()
			.from(secrets)
			.where(
				and(
					eq(secrets.serviceId, row.serviceId),
					inArray(secrets.key, ["CRON_BASE_URL", "CRON_SECRET"]),
				),
			);
		const encrypted = new Map(
			values.map((value) => [value.key, value.encryptedValue]),
		);
		base = encrypted.get("CRON_BASE_URL")
			? await decryptSecret(encrypted.get("CRON_BASE_URL")!)
			: "";
		secret = encrypted.get("CRON_SECRET")
			? await decryptSecret(encrypted.get("CRON_SECRET")!)
			: undefined;
	} catch {
		status = "failed";
		error = "Cron configuration could not be loaded";
	}
	if (error === null) {
		try {
			if (!base.trim()) throw new Error("CRON_BASE_URL is not configured");
			const url = parseCronUrl(base.trim(), row.cron.path);
			validateCronTransport(url, secret);
			try {
				({ status, statusCode, error } = await performCronGet(
					url,
					secret,
					deadline - Date.now(),
				));
			} catch (cause) {
				status = "failed";
				error = sanitizeCronError(cause);
			}
		} catch (cause) {
			error = sanitizeCronError(cause);
			status = "skipped";
		}
	}
	const finishedAt = new Date();
	const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());
	await db
		.update(serviceCrons)
		.set({
			lastFinishedAt: finishedAt,
			lastStatus: status,
			lastStatusCode: statusCode,
			lastDurationMs: durationMs,
			lastError: error,
		})
		.where(eq(serviceCrons.id, cronId));
	const log: CronLog = {
		_msg: `Cron ${status}`,
		_time: finishedAt.toISOString(),
		service_id: row.serviceId,
		cron_id: cronId,
		path: row.cron.path,
		source,
		scheduled_for: scheduledFor.toISOString(),
		started_at: startedAt.toISOString(),
		finished_at: finishedAt.toISOString(),
		result: status,
		status: statusCode,
		duration_ms: durationMs,
		error,
		log_type: "cron",
	};
	await ingestCronLog(log);
	if (status === "failed") {
		notify({
			kind: "cron.failed",
			occurrenceId: cronEventId(cronId, scheduledFor),
			serviceId: row.serviceId,
			path: row.cron.path,
			statusCode,
			error,
		}).catch((cause) => {
			console.error(
				"[service-cron] failed to enqueue cron failure notification:",
				cause,
			);
		});
	}
	return { stale: false as const, status, statusCode, error };
}
