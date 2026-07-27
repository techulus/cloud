import { sql } from "drizzle-orm";
import { Client, type Notification } from "pg";
import { db } from "@/db";

const WORK_QUEUE_NOTIFICATION_CHANNEL = "agent_work";

type Waiter = {
	notify: () => void;
	disconnect: () => void;
};

export type WorkNotificationSubscription = {
	wait: (
		timeoutMs: number,
		signal?: AbortSignal,
	) => Promise<"notified" | "timeout" | "unavailable" | "aborted">;
	close: () => void;
};

class WorkQueueNotificationDispatcher {
	private readonly waiters = new Map<string, Set<Waiter>>();
	private disconnected = false;

	private constructor(private readonly client: Client) {}

	static async connect(onDisconnect: () => void) {
		const client = new Client({ connectionString: process.env.DATABASE_URL });
		const dispatcher = new WorkQueueNotificationDispatcher(client);
		client.on("notification", (message) =>
			dispatcher.handleNotification(message),
		);
		client.on("error", () => dispatcher.handleDisconnect(onDisconnect));
		client.on("end", () => dispatcher.handleDisconnect(onDisconnect));
		try {
			await client.connect();
			await client.query(`LISTEN ${WORK_QUEUE_NOTIFICATION_CHANNEL}`);
		} catch (error) {
			client.removeAllListeners();
			await client.end().catch(() => undefined);
			throw error;
		}
		return dispatcher;
	}

	subscribe(serverId: string): WorkNotificationSubscription {
		let notified = false;
		let disconnected = this.disconnected;
		let resolveWait:
			| ((value: "notified" | "timeout" | "unavailable" | "aborted") => void)
			| undefined;
		let closed = false;

		const waiter: Waiter = {
			notify: () => {
				notified = true;
				resolveWait?.("notified");
			},
			disconnect: () => {
				disconnected = true;
				resolveWait?.("unavailable");
			},
		};
		const serverWaiters = this.waiters.get(serverId) ?? new Set<Waiter>();
		serverWaiters.add(waiter);
		this.waiters.set(serverId, serverWaiters);

		return {
			wait: (timeoutMs, signal) => {
				if (notified) return Promise.resolve("notified");
				if (disconnected) return Promise.resolve("unavailable");
				if (signal?.aborted) return Promise.resolve("aborted");
				return new Promise<"notified" | "timeout" | "unavailable" | "aborted">(
					(resolve) => {
						let timer: ReturnType<typeof setTimeout>;
						const finish = (
							result: "notified" | "timeout" | "unavailable" | "aborted",
						) => {
							clearTimeout(timer);
							signal?.removeEventListener("abort", onAbort);
							resolveWait = undefined;
							resolve(result);
						};
						const onAbort = () => finish("aborted");
						resolveWait = finish;
						timer = setTimeout(() => finish("timeout"), timeoutMs);
						signal?.addEventListener("abort", onAbort, { once: true });
					},
				);
			},
			close: () => {
				if (closed) return;
				closed = true;
				resolveWait?.("aborted");
				serverWaiters.delete(waiter);
				if (serverWaiters.size === 0) this.waiters.delete(serverId);
			},
		};
	}

	private handleNotification(message: Notification) {
		if (
			message.channel !== WORK_QUEUE_NOTIFICATION_CHANNEL ||
			!message.payload
		) {
			return;
		}
		for (const waiter of this.waiters.get(message.payload) ?? []) {
			waiter.notify();
		}
	}

	private handleDisconnect(onDisconnect: () => void) {
		if (this.disconnected) return;
		this.disconnected = true;
		for (const serverWaiters of this.waiters.values()) {
			for (const waiter of serverWaiters) waiter.disconnect();
		}
		this.waiters.clear();
		onDisconnect();
		void this.client.end().catch(() => undefined);
	}
}

const globalForWorkNotifications = globalThis as typeof globalThis & {
	workQueueNotificationDispatcher?: Promise<WorkQueueNotificationDispatcher>;
};

async function getWorkQueueNotificationDispatcher() {
	if (!globalForWorkNotifications.workQueueNotificationDispatcher) {
		let dispatcherPromise: Promise<WorkQueueNotificationDispatcher>;
		dispatcherPromise = WorkQueueNotificationDispatcher.connect(() => {
			if (
				globalForWorkNotifications.workQueueNotificationDispatcher ===
				dispatcherPromise
			) {
				delete globalForWorkNotifications.workQueueNotificationDispatcher;
			}
		});
		globalForWorkNotifications.workQueueNotificationDispatcher =
			dispatcherPromise;
		dispatcherPromise.catch(() => {
			if (
				globalForWorkNotifications.workQueueNotificationDispatcher ===
				dispatcherPromise
			) {
				delete globalForWorkNotifications.workQueueNotificationDispatcher;
			}
		});
	}
	return globalForWorkNotifications.workQueueNotificationDispatcher;
}

export async function subscribeToWorkNotifications(serverId: string) {
	const dispatcher = await getWorkQueueNotificationDispatcher();
	return dispatcher.subscribe(serverId);
}

export async function notifyWorkAvailable(serverId: string) {
	await db.execute(
		sql`SELECT pg_notify(${WORK_QUEUE_NOTIFICATION_CHANNEL}, ${serverId})`,
	);
}
