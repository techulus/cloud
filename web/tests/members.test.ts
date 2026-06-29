import { describe, expect, it } from "vitest";
import {
	canAdminister,
	canRead,
	canWrite,
	createInviteToken,
	hashInviteToken,
	isInvitableMemberRole,
	isMemberRole,
} from "@/lib/members";

describe("member roles", () => {
	it("validates supported roles", () => {
		expect(isMemberRole("admin")).toBe(true);
		expect(isMemberRole("developer")).toBe(true);
		expect(isMemberRole("reader")).toBe(true);
		expect(isMemberRole("owner")).toBe(false);
	});

	it("validates invitable roles", () => {
		expect(isInvitableMemberRole("developer")).toBe(true);
		expect(isInvitableMemberRole("reader")).toBe(true);
		expect(isInvitableMemberRole("admin")).toBe(false);
	});

	it("maps role capabilities", () => {
		expect(canRead("reader")).toBe(true);
		expect(canWrite("reader")).toBe(false);
		expect(canWrite("developer")).toBe(true);
		expect(canAdminister("developer")).toBe(false);
		expect(canAdminister("admin")).toBe(true);
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
