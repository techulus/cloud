import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { Address4, Address6 } from "ip-address";
import { db } from "@/db";
import { secrets, serviceCrons, services } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { isSafeCronPath, nextOccurrenceAfter } from "@/lib/public-api";
import { ingestCronLog, type CronLog } from "@/lib/victoria-logs";

const MAX_ERROR = 500;
const EXECUTION_BUDGET_MS = 10_000;
const blockedV4 = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
].map((value) => new Address4(value));
const blockedV6 = ["2001::/23", "2001:db8::/32", "3fff::/20"].map(
	(value) => new Address6(value),
);

export type ResolvedAddress = { address: string; family: 4 | 6 };
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

export function isGlobalAddress(value: string): boolean {
	try {
		if (isIP(value) === 4) {
			const address = new Address4(value);
			return !blockedV4.some((range) => address.isInSubnet(range));
		}
		if (isIP(value) === 6) {
			const address = new Address6(value);
			if (address.is4()) return isGlobalAddress(address.to4().address);
			return (
				address.isInSubnet(new Address6("2000::/3")) &&
				!blockedV6.some((range) => address.isInSubnet(range))
			);
		}
	} catch {}
	return false;
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

export async function resolvePublicAddresses(
	hostname: string,
	lookup: (
		hostname: string,
		options: { all: true; verbatim: true },
	) => Promise<ResolvedAddress[]> = async (host, options) =>
		(await dnsLookup(host, options)).map((answer) => ({
			address: answer.address,
			family: answer.family as 4 | 6,
		})),
): Promise<ResolvedAddress[]> {
	const literal = isIP(hostname);
	let answers: ResolvedAddress[];
	try {
		answers = literal
			? [{ address: hostname, family: literal as 4 | 6 }]
			: await lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new Error("DNS lookup failed");
	}
	if (
		!answers.length ||
		answers.some(({ address }) => !isGlobalAddress(address))
	)
		throw new Error("Cron destination is not public");
	return answers;
}

type RequestImpl = typeof http.request;
export function validateCronTransport(url: URL, secret?: string): void {
	if (secret && url.protocol === "http:")
		throw new Error("CRON_SECRET requires HTTPS");
}

export async function performCronGet(
	url: URL,
	addresses: ResolvedAddress[],
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
		const requestOptions: http.RequestOptions & { autoSelectFamily: boolean } =
			{
				method: "GET",
				agent: false,
				autoSelectFamily: false,
				headers: secret ? { Authorization: `Bearer ${secret}` } : undefined,
				lookup: (_hostname, options, callback) => {
					const selected = addresses[0];
					if (options?.all) callback(null, addresses);
					else callback(null, selected.address, selected.family);
				},
				...(url.protocol === "https:" ? { servername: url.hostname } : {}),
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

async function withinDeadline<T>(
	promise: Promise<T>,
	deadline: number,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Cron request timed out");
	let timer: ReturnType<typeof setTimeout>;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Cron request timed out")),
					remaining,
				);
			}),
		]);
	} finally {
		clearTimeout(timer!);
	}
}

export async function executeServiceCron(
	cronId: string,
	schedule: string,
	scheduledFor: Date,
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
		.set({ lastAttemptedFor: scheduledFor, lastStartedAt: startedAt })
		.where(
			and(
				eq(serviceCrons.id, cronId),
				eq(serviceCrons.schedule, schedule),
				or(
					isNull(serviceCrons.lastAttemptedFor),
					lt(serviceCrons.lastAttemptedFor, scheduledFor),
				),
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
				const addresses = await withinDeadline(
					resolvePublicAddresses(url.hostname),
					deadline,
				);
				({ status, statusCode, error } = await performCronGet(
					url,
					addresses,
					secret,
					deadline - Date.now(),
				));
			} catch (cause) {
				const message = sanitizeCronError(cause);
				status =
					message === "Cron destination is not public" ? "skipped" : "failed";
				error = message;
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
	return { stale: false as const, status, statusCode, error };
}
