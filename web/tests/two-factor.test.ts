import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTH_REDIRECT,
	type DeleteConfirmation,
	getDeleteTotpCode,
	getSafeAuthRedirect,
	getTotpSecret,
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

	it("requires a valid delete code only when 2FA is enabled", () => {
		expect(getDeleteTotpCode(false, undefined, "project")).toBeNull();
		expect(() => getDeleteTotpCode(true, undefined, "project")).toThrow(
			"Authenticator code is required to delete this project",
		);
		expect(() =>
			getDeleteTotpCode(true, { totpCode: "12345" }, "project"),
		).toThrow("Authenticator code is required to delete this project");
		expect(() =>
			getDeleteTotpCode(
				true,
				{ totpCode: 123456 } as unknown as DeleteConfirmation,
				"project",
			),
		).toThrow("Authenticator code is required to delete this project");
		expect(getDeleteTotpCode(true, { totpCode: "123456" }, "project")).toBe(
			"123456",
		);
	});
});
