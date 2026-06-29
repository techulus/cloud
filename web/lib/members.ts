import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import type { InvitableMemberRole, MemberRole } from "@/db/types";

export const MEMBER_ROLES = ["admin", "developer", "reader"] as const;
export const INVITABLE_MEMBER_ROLES = ["developer", "reader"] as const;
export const ADMIN_NOT_CONFIGURED_MESSAGE =
	"No admin user is configured. Run `pnpm admin:create <email>` from the web app to create the first admin.";

let adminConfigured = false;

export class AdminNotConfiguredError extends Error {
	code = "ADMIN_NOT_CONFIGURED";

	constructor() {
		super(ADMIN_NOT_CONFIGURED_MESSAGE);
		this.name = "AdminNotConfiguredError";
	}
}

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

export function hasAnyRole(role: MemberRole, allowedRoles: MemberRole[]) {
	return allowedRoles.includes(role);
}

export async function assertAdminConfigured() {
	if (adminConfigured) {
		return;
	}

	const admins = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.role, "admin"))
		.limit(1);

	if (admins.length > 0) {
		adminConfigured = true;
		return;
	}

	throw new AdminNotConfiguredError();
}

export async function getUserRole(userId: string): Promise<MemberRole | null> {
	await assertAdminConfigured();

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
