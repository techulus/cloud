import { describe, expect, it } from "vitest";
import {
	createInviteToken,
	hashInviteToken,
	isInvitableMemberRole,
} from "@/lib/members";

describe("member roles", () => {
	it("validates invitable roles", () => {
		expect(isInvitableMemberRole("developer")).toBe(true);
		expect(isInvitableMemberRole("reader")).toBe(true);
		expect(isInvitableMemberRole("admin")).toBe(false);
	});
});

describe("member invitations", () => {
	it("hashes invite tokens deterministically without storing the raw token", () => {
		const token = createInviteToken();
		const hash = hashInviteToken(token);

		expect(token).not.toBe(hash);
		expect(hash).toBe(hashInviteToken(token));
		expect(hash).toHaveLength(64);
	});
});
