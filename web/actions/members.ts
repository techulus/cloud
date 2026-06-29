"use server";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import isEmail from "validator/es/lib/isEmail";
import { z } from "zod";
import { db } from "@/db";
import { memberInvitations, user } from "@/db/schema";
import type { InvitableMemberRole } from "@/db/types";
import { auth, requireAdminRole } from "@/lib/auth";
import { sendMemberInviteEmail } from "@/lib/email";
import {
	createInviteToken,
	getInviteUrl,
	hashInviteToken,
	isInvitableMemberRole,
} from "@/lib/members";

const INVITE_EXPIRY_MS = 1000 * 60 * 60 * 24 * 7;

const inviteMemberSchema = z.object({
	email: z.string().trim().email(),
	role: z.enum(["developer", "reader"]),
});

const acceptInviteSchema = z.object({
	token: z.string().min(1),
	name: z.string().trim().min(1, "Name is required"),
	password: z.string().min(8, "Password must be at least 8 characters"),
});

type CreateUserResult = {
	user: {
		id: string;
	};
};

type CreateUserInput = {
	body: {
		email: string;
		name: string;
		password: string;
		role: InvitableMemberRole;
	};
};

async function createAuthUser(input: CreateUserInput) {
	return (
		auth.api.createUser as (data: CreateUserInput) => Promise<CreateUserResult>
	)(input);
}

function isExpired(expiresAt: Date) {
	return expiresAt.getTime() <= Date.now();
}

async function markExpiredInvitations() {
	await db
		.update(memberInvitations)
		.set({ status: "expired" })
		.where(
			and(
				eq(memberInvitations.status, "pending"),
				lte(memberInvitations.expiresAt, new Date()),
			),
		);
}

async function requireAdminSession() {
	const session = await requireAdminRole();
	if (!session) {
		throw new Error("Unauthorized");
	}

	return session;
}

export async function listMembers() {
	await requireAdminSession();

	await markExpiredInvitations();

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
		await db
			.update(memberInvitations)
			.set({ status: "expired" })
			.where(eq(memberInvitations.id, invite.id));
		return { ...invite, status: "expired" as const };
	}

	return invite;
}

export async function inviteMember(input: {
	email: string;
	role: InvitableMemberRole;
}) {
	const session = await requireAdminSession();

	const parsed = inviteMemberSchema.parse(input);
	const email = parsed.email.toLowerCase();

	const existingUser = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);

	if (existingUser.length > 0) {
		throw new Error("A member with this email already exists");
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
	const inviteUrl = getInviteUrl(token);
	const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

	await db.insert(memberInvitations).values({
		id: randomUUID(),
		email,
		role: parsed.role,
		tokenHash: hashInviteToken(token),
		status: "pending",
		invitedByUserId: session.user.id,
		expiresAt,
	});

	const emailSent = await sendMemberInviteEmail({
		to: email,
		inviterName: session.user.name,
		role: parsed.role,
		inviteUrl,
	});

	revalidatePath("/dashboard/settings");
	return { success: true, inviteUrl, emailSent };
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

	const now = new Date();
	const [claimedInvite] = await db
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

	let created: CreateUserResult;
	try {
		created = await createAuthUser({
			body: {
				email: claimedInvite.email,
				name: parsed.name,
				password: parsed.password,
				role: claimedInvite.role,
			},
		});
	} catch (error) {
		await db
			.update(memberInvitations)
			.set({
				status: "pending",
				acceptedAt: null,
			})
			.where(
				and(
					eq(memberInvitations.id, claimedInvite.id),
					eq(memberInvitations.status, "accepted"),
					isNull(memberInvitations.acceptedByUserId),
				),
			);
		throw error;
	}

	await db
		.update(memberInvitations)
		.set({
			acceptedByUserId: created.user.id,
		})
		.where(eq(memberInvitations.id, claimedInvite.id));

	return { success: true };
}
