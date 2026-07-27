"use server";

import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, asc, desc, eq, gt, lte, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import isEmail from "validator/es/lib/isEmail";
import { z } from "zod";
import { db } from "@/db";
import { account, memberInvitations, user } from "@/db/schema";
import type { InvitableMemberRole } from "@/db/types";
import { requireAdminRole } from "@/lib/auth";
import { addMilliseconds, DAY_IN_MILLISECONDS, isExpired } from "@/lib/date";
import { sendMemberInviteEmail } from "@/lib/email";
import {
	createInviteToken,
	hashInviteToken,
	isInvitableMemberRole,
} from "@/lib/members";

const INVITE_EXPIRY_MS = 7 * DAY_IN_MILLISECONDS;

const inviteMemberSchema = z.object({
	email: z.string().trim().email(),
	role: z.enum(["developer", "reader"]),
});

const acceptInviteSchema = z.object({
	token: z.string().min(1),
	name: z.string().trim().min(1, "Name is required"),
	password: z.string().min(8, "Password must be at least 8 characters"),
});

async function requireAdminSession() {
	const session = await requireAdminRole();
	if (!session) {
		throw new Error("Unauthorized");
	}

	return session;
}

export async function listMembers() {
	await requireAdminSession();

	await db
		.update(memberInvitations)
		.set({ status: "expired" })
		.where(
			and(
				eq(memberInvitations.status, "pending"),
				lte(memberInvitations.expiresAt, new Date()),
			),
		);

	const [members, invitations] = await Promise.all([
		db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				role: user.role,
				createdAt: user.createdAt,
			})
			.from(user)
			.orderBy(asc(user.createdAt)),
		db
			.select({
				id: memberInvitations.id,
				email: memberInvitations.email,
				role: memberInvitations.role,
				status: memberInvitations.status,
				expiresAt: memberInvitations.expiresAt,
				createdAt: memberInvitations.createdAt,
			})
			.from(memberInvitations)
			.where(eq(memberInvitations.status, "pending"))
			.orderBy(desc(memberInvitations.createdAt)),
	]);

	return { members, invitations };
}

// react-doctor-disable-next-line react-doctor/server-auth-actions -- intentionally public; possession of the opaque invite token authorizes this lookup
export async function getInviteByToken(token: string) {
	const tokenHash = hashInviteToken(token);
	const [invite] = await db
		.select({
			id: memberInvitations.id,
			email: memberInvitations.email,
			role: memberInvitations.role,
			status: memberInvitations.status,
			expiresAt: memberInvitations.expiresAt,
		})
		.from(memberInvitations)
		.where(eq(memberInvitations.tokenHash, tokenHash))
		.limit(1);

	if (!invite) {
		return null;
	}

	if (invite.status === "pending" && isExpired(invite.expiresAt)) {
		return { ...invite, status: "expired" as const };
	}

	return invite;
}

export async function inviteMember(input: {
	email: string;
	role: InvitableMemberRole;
}) {
	const session = await requireAdminSession();

	const parsed = inviteMemberSchema.safeParse(input);
	if (!parsed.success) {
		return {
			success: false as const,
			error: parsed.error.issues[0]?.message ?? "Invalid invitation details",
		};
	}

	const email = parsed.data.email.toLowerCase();

	const existingUser = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);

	if (existingUser.length > 0) {
		return {
			success: false as const,
			error: "A member with this email already exists",
		};
	}

	await db
		.update(memberInvitations)
		.set({ status: "revoked" })
		.where(
			and(
				eq(memberInvitations.email, email),
				eq(memberInvitations.status, "pending"),
			),
		);

	const token = createInviteToken();
	let baseUrl = process.env.APP_URL?.replace(/\/$/, "");
	if (!baseUrl) {
		const requestHeaders = await headers();
		const host =
			requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() ??
			requestHeaders.get("host");
		const protocol =
			requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";
		if (host) {
			baseUrl = `${protocol}://${host}`;
		}
	}

	if (!baseUrl) {
		throw new Error("APP_URL is required to create member invitations");
	}

	const inviteUrl = `${baseUrl}/invite/${encodeURIComponent(token)}`;
	const expiresAt = addMilliseconds(new Date(), INVITE_EXPIRY_MS);

	await db.insert(memberInvitations).values({
		id: randomUUID(),
		email,
		role: parsed.data.role,
		tokenHash: hashInviteToken(token),
		status: "pending",
		invitedByUserId: session.user.id,
		expiresAt,
	});

	const emailSent = await sendMemberInviteEmail({
		to: email,
		inviterName: session.user.name,
		role: parsed.data.role,
		inviteUrl,
	});

	revalidatePath("/dashboard/settings");
	return { success: true as const, inviteUrl, emailSent };
}

export async function revokeInvitation(invitationId: string) {
	await requireAdminSession();

	await db
		.update(memberInvitations)
		.set({ status: "revoked" })
		.where(
			and(
				eq(memberInvitations.id, invitationId),
				eq(memberInvitations.status, "pending"),
			),
		);

	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function updateMemberRole(
	userId: string,
	role: InvitableMemberRole,
) {
	await requireAdminSession();

	if (!isInvitableMemberRole(role)) {
		throw new Error("Invalid role");
	}

	await db
		.update(user)
		.set({ role })
		.where(and(eq(user.id, userId), ne(user.role, "admin")));

	revalidatePath("/dashboard/settings");
	return { success: true };
}

export async function removeMember(userId: string) {
	await requireAdminSession();

	await db.delete(user).where(and(eq(user.id, userId), ne(user.role, "admin")));

	revalidatePath("/dashboard/settings");
	return { success: true };
}

// react-doctor-disable-next-line react-doctor/server-auth-actions -- intentionally public; the opaque invite token is validated and atomically consumed below
export async function acceptInvite(input: {
	token: string;
	name: string;
	password: string;
}) {
	const parsed = acceptInviteSchema.parse(input);
	const invite = await getInviteByToken(parsed.token);

	if (!invite || invite.status !== "pending") {
		throw new Error("Invitation is invalid or no longer available");
	}

	if (isExpired(invite.expiresAt)) {
		throw new Error("Invitation has expired");
	}

	if (!isEmail(invite.email)) {
		throw new Error("Invitation email is invalid");
	}

	const existingUser = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, invite.email))
		.limit(1);

	if (existingUser.length > 0) {
		throw new Error("A member with this email already exists");
	}

	const passwordHash = await hashPassword(parsed.password);
	try {
		await db.transaction(async (tx) => {
			const now = new Date();
			const [claimedInvite] = await tx
				.update(memberInvitations)
				.set({
					status: "accepted",
					acceptedAt: now,
				})
				.where(
					and(
						eq(memberInvitations.id, invite.id),
						eq(memberInvitations.status, "pending"),
						gt(memberInvitations.expiresAt, now),
					),
				)
				.returning({
					id: memberInvitations.id,
					email: memberInvitations.email,
					role: memberInvitations.role,
				});

			if (!claimedInvite) {
				throw new Error("Invitation is invalid or no longer available");
			}

			const userId = randomUUID();
			await tx.insert(user).values({
				id: userId,
				email: claimedInvite.email,
				name: parsed.name,
				emailVerified: false,
				role: claimedInvite.role,
				createdAt: now,
				updatedAt: now,
			});

			await tx.insert(account).values({
				id: randomUUID(),
				accountId: userId,
				providerId: "credential",
				userId,
				password: passwordHash,
				createdAt: now,
				updatedAt: now,
			});

			await tx
				.update(memberInvitations)
				.set({ acceptedByUserId: userId })
				.where(eq(memberInvitations.id, claimedInvite.id));
		});
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as Error & { code?: string }).code === "23505"
		) {
			throw new Error("A member with this email already exists");
		}
		throw error;
	}

	return { success: true };
}
