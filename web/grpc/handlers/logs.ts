import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { containerLogs, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { LogStreamType, type LogEntry } from "../generated/proto/agent";

const BATCH_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_COUNT = 2;

type LogRecord = {
	id: string;
	deploymentId: string;
	stream: "stdout" | "stderr";
	message: string;
	timestamp: Date;
	retryCount?: number;
};

type CacheEntry = {
	deploymentId: string | null;
	cachedAt: number;
};

const logBuffer: LogRecord[] = [];
const containerCache = new Map<string, CacheEntry>();
let flushTimer: NodeJS.Timeout | null = null;
let isFlushing = false;

async function flushLogs(): Promise<void> {
	if (logBuffer.length === 0 || isFlushing) return;

	isFlushing = true;
	const toFlush = logBuffer.splice(0, logBuffer.length);

	try {
		await db.insert(containerLogs).values(
			toFlush.map(({ retryCount, ...record }) => record),
		);
	} catch (err) {
		console.error("[logs] Failed to flush logs:", err);
		const retryable = toFlush.filter((r) => (r.retryCount || 0) < MAX_RETRY_COUNT);
		if (retryable.length > 0) {
			retryable.forEach((r) => (r.retryCount = (r.retryCount || 0) + 1));
			logBuffer.unshift(...retryable);
		}
	} finally {
		isFlushing = false;
	}
}

function scheduleFlush(): void {
	if (flushTimer || isFlushing) return;
	flushTimer = setTimeout(async () => {
		flushTimer = null;
		await flushLogs();
	}, FLUSH_INTERVAL_MS);
}

async function resolveDeploymentId(entry: LogEntry): Promise<string | null> {
	if (entry.deployment_id) {
		return entry.deployment_id;
	}

	if (!entry.container_id) {
		return null;
	}

	const cached = containerCache.get(entry.container_id);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		return cached.deploymentId;
	}

	const deployment = await db
		.select({ id: deployments.id })
		.from(deployments)
		.where(eq(deployments.containerId, entry.container_id))
		.then((r) => r[0]);

	const deploymentId = deployment?.id ?? null;
	containerCache.set(entry.container_id, {
		deploymentId,
		cachedAt: Date.now(),
	});

	return deploymentId;
}

export async function handleLogEntry(entry: LogEntry): Promise<void> {
	if (entry.stream_type === LogStreamType.LOG_STREAM_TYPE_HEARTBEAT) return;

	const deploymentId = await resolveDeploymentId(entry);
	if (!deploymentId) return;

	const stream =
		entry.stream_type === LogStreamType.LOG_STREAM_TYPE_STDOUT
			? "stdout"
			: "stderr";
	const message = Buffer.from(entry.message).toString("utf-8");

	logBuffer.push({
		id: randomUUID(),
		deploymentId,
		stream,
		message,
		timestamp: new Date(Number(entry.timestamp)),
	});

	if (logBuffer.length >= BATCH_SIZE) {
		await flushLogs();
	} else {
		scheduleFlush();
	}
}
