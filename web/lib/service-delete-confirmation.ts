import { normalizeTwoFactorCode } from "@/lib/two-factor";

export type ServiceDeleteConfirmation = {
	password?: string;
	totpCode?: string;
};

export type NormalizedServiceDeleteConfirmation = {
	password: string;
	totpCode: string;
};

export function getServiceDeleteConfirmation(
	twoFactorEnabled: boolean,
	confirmation?: ServiceDeleteConfirmation,
): NormalizedServiceDeleteConfirmation | null {
	if (!twoFactorEnabled) return null;

	const password = confirmation?.password?.trim() ?? "";
	const totpCode = normalizeTwoFactorCode(confirmation?.totpCode);

	if (!password || !totpCode) {
		throw new Error(
			"Password and authenticator code are required to delete this service",
		);
	}

	return { password, totpCode };
}
