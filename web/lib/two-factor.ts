export const DEFAULT_AUTH_REDIRECT = "/dashboard";

export type DeleteConfirmation = {
	totpCode?: string;
};

export type AuthClientError = {
	message?: string;
	error_description?: string;
} | null;

export function getAuthErrorMessage(error: AuthClientError, fallback: string) {
	return error?.message || error?.error_description || fallback;
}

export function normalizeTwoFactorCode(value: string) {
	return value.replace(/\s/g, "");
}

const AUTH_REDIRECT_ORIGIN = "https://auth.local";

function hasUnsafeAuthRedirectCharacter(value: string) {
	return Array.from(value).some((character) => {
		const charCode = character.charCodeAt(0);
		return character === "\\" || charCode <= 31 || charCode === 127;
	});
}

export function getSafeAuthRedirect(value: string | null | undefined) {
	if (!value) return DEFAULT_AUTH_REDIRECT;
	if (
		value !== value.trim() ||
		hasUnsafeAuthRedirectCharacter(value) ||
		!value.startsWith("/") ||
		value.startsWith("//")
	) {
		return DEFAULT_AUTH_REDIRECT;
	}

	try {
		const url = new URL(value, AUTH_REDIRECT_ORIGIN);
		if (url.origin !== AUTH_REDIRECT_ORIGIN) return DEFAULT_AUTH_REDIRECT;

		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return DEFAULT_AUTH_REDIRECT;
	}
}

export function getTotpSecret(totpURI: string) {
	try {
		return new URL(totpURI).searchParams.get("secret") ?? "";
	} catch {
		return "";
	}
}

export function getDeleteTotpCode(
	twoFactorEnabled: boolean,
	confirmation: DeleteConfirmation | undefined,
	resource: string,
) {
	if (!twoFactorEnabled) return null;

	const totpCode = confirmation?.totpCode;
	if (typeof totpCode !== "string" || !/^\d{6}$/.test(totpCode)) {
		throw new Error(
			`Authenticator code is required to delete this ${resource}`,
		);
	}

	return totpCode;
}
