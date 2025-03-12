import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import type { User } from "better-auth";

export type Organization = {
	id: string;
	name: string;
	slug: string;
	logo: string;
	createdAt: Date;
	meta: Record<string, string | number>;
};

type Result = {
	ownerId: string;
	userId: string;
	orgId: string | null;
	orgSlug: string;
};

export async function getUser(): Promise<User> {
	const session = await auth.api.getSession({
		headers: await headers(),
	});
	if (!session) {
		redirect("/sign-in");
	}

	return session.user;
}

export async function getOwner(): Promise<Result> {
	const session = await auth.api.getSession({
		headers: await headers(),
	});
	if (!session) {
		redirect("/sign-in");
	}

	const userId = session.user.id;
	const activeOrgId = session.session.activeOrganizationId;

	return {
		ownerId: activeOrgId ?? userId,
		userId,
		orgId: activeOrgId,
	} as Result;
}

export async function getOrganizations(): Promise<Organization[]> {
	const organizations = await auth.api.listOrganizations({
		headers: await headers(),
	});
	return organizations as Organization[];
}
