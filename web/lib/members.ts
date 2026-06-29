import { createHash, randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import type { InvitableMemberRole, MemberRole } from "@/db/types";

export const MEMBER_ROLES = ["admin", "developer", "reader"] as const;
export const INVITABLE_MEMBER_ROLES = ["developer", "reader"] as const;

export function isMemberRole(value: unknown): value is MemberRole {
	return (
		typeof value === "string" &&
		MEMBER_ROLES.includes(value as (typeof MEMBER_ROLES)[number])
	);
}

export function isInvitableMemberRole(
	value: unknown,
): value is InvitableMemberRole {
	return (
		typeof value === "string" &&
		INVITABLE_MEMBER_ROLES.includes(
			value as (typeof INVITABLE_MEMBER_ROLES)[number],
		)
	);
}

export function canRead(role: MemberRole) {
	return role === "admin" || role === "developer" || role === "reader";
}

export function canWrite(role: MemberRole) {
	return role === "admin" || role === "developer";
}

export function canAdminister(role: MemberRole) {
	return role === "admin";
}

export function hasAnyRole(role: MemberRole, allowedRoles: MemberRole[]) {
	return allowedRoles.includes(role);
}

export async function ensureAdminExists() {
	const admins = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.role, "admin"))
		.limit(1);

	if (admins.length > 0) {
		return;
	}

	const [firstUser] = await db
		.select({ id: user.id })
		.from(user)
		.orderBy(asc(user.createdAt))
		.limit(1);

	if (!firstUser) {
		return;
	}

	await db.update(user).set({ role: "admin" }).where(eq(user.id, firstUser.id));
}

export async function getUserRole(userId: string): Promise<MemberRole | null> {
	await ensureAdminExists();

	const [record] = await db
		.select({ role: user.role })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	return record?.role ?? null;
}

export function createInviteToken() {
	return randomBytes(32).toString("base64url");
}

export function hashInviteToken(token: string) {
	return createHash("sha256").update(token).digest("hex");
}

export function getInviteUrl(token: string) {
	const baseUrl = process.env.APP_URL?.replace(/\/$/, "");
	const path = `/invite/${encodeURIComponent(token)}`;
	return baseUrl ? `${baseUrl}${path}` : path;
}
