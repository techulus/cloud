import { eq } from "drizzle-orm";
import { Client, type Notification } from "pg";
import { db } from "@/db";
import { servers } from "@/db/schema";

const CHANNEL = "agent_generation";
const MAX_POLLS = 1_000;
const POLL_INTERVAL_MS = 1_000;
const WAKE_TIMEOUT_MS = 25_000;

type Subscriber = () => void;
type Subscribe = (
	serverId: string,
	subscriber: Subscriber,
) => Promise<() => void>;

const subscribers = new Map<string, Set<Subscriber>>();
const activePolls = new Set<string>();
let listener: Client | undefined;
let listenerReady: Promise<void> | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;

function scheduleReconnect(disconnectedClient?: Client) {
	if (disconnectedClient && listener !== disconnectedClient) return;
	listener = undefined;
	listenerReady = undefined;
	if (reconnectTimer || subscribers.size === 0) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		void ensureListener().catch(() => scheduleReconnect());
	}, POLL_INTERVAL_MS);
	reconnectTimer.unref();
}

function ensureListener(): Promise<void> {
	if (listenerReady) return listenerReady;

	const client = new Client({ connectionString: process.env.DATABASE_URL });
	listener = client;
	client.on("notification", (notification: Notification) => {
		if (notification.channel !== CHANNEL || !notification.payload) return;
		const separator = notification.payload.lastIndexOf(":");
		if (separator < 1) return;
		const serverId = notification.payload.slice(0, separator);
		for (const subscriber of subscribers.get(serverId) ?? []) subscriber();
	});
	client.on("error", () => scheduleReconnect(client));
	client.on("end", () => scheduleReconnect(client));

	listenerReady = client
		.connect()
		.then(() => client.query(`LISTEN ${CHANNEL}`))
		.then(() => undefined)
		.catch(async (error) => {
			await client.end().catch(() => undefined);
			scheduleReconnect(client);
			throw error;
		});
	return listenerReady;
}

async function subscribe(
	serverId: string,
	subscriber: Subscriber,
): Promise<() => void> {
	let serverSubscribers = subscribers.get(serverId);
	if (!serverSubscribers) {
		serverSubscribers = new Set();
		subscribers.set(serverId, serverSubscribers);
	}
	serverSubscribers.add(subscriber);

	// Registration precedes LISTEN readiness and the caller's generation re-read.
	// A failed listener is harmless because periodic reads remain authoritative.
	await ensureListener().catch(() => undefined);
	return () => {
		serverSubscribers.delete(subscriber);
		if (serverSubscribers.size === 0) subscribers.delete(serverId);
	};
}

export async function readAgentGeneration(
	serverId: string,
): Promise<number | null> {
	const [server] = await db
		.select({ generation: servers.agentGeneration })
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	return server?.generation ?? null;
}

export type WakeResult =
	| { kind: "advanced"; generation: number }
	| { kind: "timeout" }
	| { kind: "aborted" }
	| { kind: "duplicate" }
	| { kind: "capacity" }
	| { kind: "not-found" };

export async function waitForAgentGeneration(
	serverId: string,
	cursor: number,
	signal: AbortSignal,
	options: {
		readGeneration?: (serverId: string) => Promise<number | null>;
		subscribe?: Subscribe;
		timeoutMs?: number;
		pollIntervalMs?: number;
	} = {},
): Promise<WakeResult> {
	if (activePolls.has(serverId)) return { kind: "duplicate" };
	if (activePolls.size >= MAX_POLLS) return { kind: "capacity" };
	activePolls.add(serverId);

	const readGeneration = options.readGeneration ?? readAgentGeneration;
	const register = options.subscribe ?? subscribe;
	const timeoutMs = options.timeoutMs ?? WAKE_TIMEOUT_MS;
	const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

	return new Promise<WakeResult>((resolve, reject) => {
		let finished = false;
		let reading = false;
		let unsubscribe: (() => void) | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let interval: NodeJS.Timeout | undefined;

		const finish = (result: WakeResult) => {
			if (finished) return;
			finished = true;
			unsubscribe?.();
			if (timeout) clearTimeout(timeout);
			if (interval) clearInterval(interval);
			signal.removeEventListener("abort", onAbort);
			activePolls.delete(serverId);
			resolve(result);
		};
		const fail = (error: unknown) => {
			if (finished) return;
			finished = true;
			unsubscribe?.();
			if (timeout) clearTimeout(timeout);
			if (interval) clearInterval(interval);
			signal.removeEventListener("abort", onAbort);
			activePolls.delete(serverId);
			reject(error);
		};
		const onAbort = () => finish({ kind: "aborted" });
		const check = async () => {
			if (finished || reading) return;
			reading = true;
			try {
				const generation = await readGeneration(serverId);
				if (generation === null) finish({ kind: "not-found" });
				else if (generation > cursor) finish({ kind: "advanced", generation });
			} catch (error) {
				fail(error);
			} finally {
				reading = false;
			}
		};

		void (async () => {
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
			unsubscribe = await register(serverId, () => void check());
			if (finished) return unsubscribe();
			await check();
			if (finished) return;
			timeout = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
			interval = setInterval(() => void check(), pollIntervalMs);
		})().catch(fail);
	});
}
