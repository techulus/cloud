import { describe, expect, it } from "vitest";
import { getServiceDeleteConfirmation } from "@/lib/service-delete-confirmation";

describe("service delete confirmation", () => {
	it("does not require confirmation when 2FA is disabled", () => {
		expect(getServiceDeleteConfirmation(false)).toBeNull();
	});

	it("requires password and authenticator code when 2FA is enabled", () => {
		expect(() => getServiceDeleteConfirmation(true)).toThrow(
			"Password and authenticator code are required to delete this service",
		);
		expect(() =>
			getServiceDeleteConfirmation(true, { password: "secret" }),
		).toThrow(
			"Password and authenticator code are required to delete this service",
		);
		expect(() =>
			getServiceDeleteConfirmation(true, { totpCode: "123456" }),
		).toThrow(
			"Password and authenticator code are required to delete this service",
		);
	});

	it("trims password and normalizes authenticator code", () => {
		expect(
			getServiceDeleteConfirmation(true, {
				password: " secret ",
				totpCode: "123 456",
			}),
		).toEqual({
			password: "secret",
			totpCode: "123456",
		});
	});
});
