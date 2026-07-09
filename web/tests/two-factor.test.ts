import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTH_REDIRECT,
	getSafeAuthRedirect,
	getTotpSecret,
	normalizeTwoFactorCode,
} from "@/lib/two-factor";

describe("two-factor helpers", () => {
	it("keeps internal auth redirects", () => {
		expect(getSafeAuthRedirect("/dashboard/projects/demo")).toBe(
			"/dashboard/projects/demo",
		);
	});

	it("falls back for missing or external auth redirects", () => {
		expect(getSafeAuthRedirect(null)).toBe(DEFAULT_AUTH_REDIRECT);
		expect(getSafeAuthRedirect("https://example.com")).toBe(
			DEFAULT_AUTH_REDIRECT,
		);
		expect(getSafeAuthRedirect("//example.com")).toBe(DEFAULT_AUTH_REDIRECT);
		expect(getSafeAuthRedirect("/\\example.com")).toBe(DEFAULT_AUTH_REDIRECT);
		expect(getSafeAuthRedirect("/\\/example.com")).toBe(DEFAULT_AUTH_REDIRECT);
		expect(getSafeAuthRedirect(" /dashboard")).toBe(DEFAULT_AUTH_REDIRECT);
		expect(getSafeAuthRedirect("/dashboard\n")).toBe(DEFAULT_AUTH_REDIRECT);
	});

	it("extracts the secret from a TOTP URI", () => {
		expect(
			getTotpSecret(
				"otpauth://totp/Techulus%20Cloud:agent@example.com?secret=ABC123&issuer=Techulus%20Cloud",
			),
		).toBe("ABC123");
	});

	it("returns an empty secret for malformed TOTP URIs", () => {
		expect(getTotpSecret("not a uri")).toBe("");
	});

	it("normalizes two-factor codes by removing whitespace", () => {
		expect(normalizeTwoFactorCode(" 123 456\n")).toBe("123456");
		expect(normalizeTwoFactorCode(null)).toBe("");
	});
});
