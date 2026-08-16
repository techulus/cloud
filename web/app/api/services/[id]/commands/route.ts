import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { getService } from "@/db/queries";
import { deployments, servers, serviceCommands, services } from "@/db/schema";
import { requireRequestDeveloperRole } from "@/lib/api-auth";
import { observedReadyPhases } from "@/lib/deployment-status";
import {
	decodeTimestampCursor,
	encodeTimestampCursor,
} from "@/lib/public-api-pagination";
import { enqueueWork } from "@/lib/work-queue";

const PAGE_SIZE = 25;
const MAX_COMMAND_LENGTH = 4096;

export async function GET(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireRequestDeveloperRole(request);
	if (!auth.ok) return auth.response;

	const { id: serviceId } = await params;
	if (!(await getService(serviceId))) {
		return Response.json({ error: "Service not found" }, { status: 404 });
	}
	const cursorValue = new URL(request.url).searchParams.get("cursor");
	const cursor = decodeTimestampCursor(cursorValue);
	if (cursorValue && !cursor) {
		return Response.json({ error: "Invalid cursor" }, { status: 400 });
	}

	const rows = await db
		.select({
			id: serviceCommands.id,
			command: serviceCommands.command,
			status: serviceCommands.status,
			output: serviceCommands.output,
			exitCode: serviceCommands.exitCode,
			outputTruncated: serviceCommands.outputTruncated,
			errorMessage: serviceCommands.errorMessage,
			actor: serviceCommands.actor,
			serverName: serviceCommands.serverName,
			containerId: serviceCommands.containerId,
			createdAt: serviceCommands.createdAt,
			cursorCreatedAt: sql<string>`${serviceCommands.createdAt}::text`,
			startedAt: serviceCommands.startedAt,
			completedAt: serviceCommands.completedAt,
		})
		.from(serviceCommands)
		.where(
			and(
				eq(serviceCommands.serviceId, serviceId),
				cursor
					? or(
							lt(
								serviceCommands.createdAt,
								sql`${cursor.createdAt}::timestamptz`,
							),
							and(
								eq(
									serviceCommands.createdAt,
									sql`${cursor.createdAt}::timestamptz`,
								),
								lt(serviceCommands.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(desc(serviceCommands.createdAt), desc(serviceCommands.id))
		.limit(PAGE_SIZE + 1);

	const pageRows = rows.slice(0, PAGE_SIZE);
	const last = pageRows.at(-1);
	return Response.json({
		commands: pageRows.map(({ cursorCreatedAt: _, actor, ...command }) => ({
			...command,
			actor: { name: actor.name },
		})),
		nextCursor:
			rows.length > PAGE_SIZE && last
				? encodeTimestampCursor({
						createdAt: last.cursorCreatedAt,
						id: last.id,
					})
				: null,
	});
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireRequestDeveloperRole(request);
	if (!auth.ok) return auth.response;

	const { id: serviceId } = await params;
	let body: { deploymentId?: unknown; command?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (
		typeof body.command !== "string" ||
		body.command.trim().length === 0 ||
		body.command.length > MAX_COMMAND_LENGTH ||
		typeof body.deploymentId !== "string"
	) {
		return Response.json(
			{ error: "A deployment and command of 1-4096 characters are required" },
			{ status: 400 },
		);
	}

	const service = await db
		.select({ id: services.id })
		.from(services)
		.where(
			and(
				eq(services.id, serviceId),
				isNull(services.deletedAt),
				isNull(services.previewOfServiceId),
			),
		)
		.then((rows) => rows[0]);
	if (!service) {
		return Response.json({ error: "Service not found" }, { status: 404 });
	}

	const target = await db
		.select({
			deploymentId: deployments.id,
			serverId: deployments.serverId,
			containerId: deployments.containerId,
			serverName: servers.name,
		})
		.from(deployments)
		.innerJoin(servers, eq(servers.id, deployments.serverId))
		.where(
			and(
				eq(deployments.id, body.deploymentId),
				eq(deployments.serviceId, serviceId),
				eq(deployments.runtimeDesiredState, "running"),
				inArray(deployments.observedPhase, observedReadyPhases),
				eq(servers.status, "online"),
			),
		)
		.then((rows) => rows[0]);
	if (!target?.containerId) {
		return Response.json(
			{ error: "Container is no longer runnable" },
			{ status: 409 },
		);
	}
	const containerId = target.containerId;

	const commandId = randomUUID();
	await db.transaction(async (tx) => {
		await tx.insert(serviceCommands).values({
			id: commandId,
			serviceId,
			deploymentId: target.deploymentId,
			serverId: target.serverId,
			serverName: target.serverName,
			containerId,
			actor: { id: auth.session.user.id, name: auth.session.user.name },
			command: body.command as string,
		});
		await enqueueWork(
			target.serverId,
			"command",
			{
				commandRunId: commandId,
				serviceId,
				deploymentId: target.deploymentId,
				containerId,
				command: body.command as string,
			},
			{ id: commandId, tx },
		);
	});

	return Response.json({ id: commandId, status: "pending" }, { status: 202 });
}
