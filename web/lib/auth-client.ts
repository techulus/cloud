import { apiKeyClient } from "@better-auth/api-key/client";
import {
	deviceAuthorizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { getSafeAuthRedirect } from "@/lib/two-factor";

function getTwoFactorRedirectUrl() {
	if (typeof window === "undefined") return "/two-factor";

	const redirectTo = getSafeAuthRedirect(
		new URLSearchParams(window.location.search).get("redirect"),
	);
	const target = new URL("/two-factor", window.location.origin);
	target.searchParams.set("redirect", redirectTo);
	return target.toString();
}

export const authClient = createAuthClient({
	plugins: [
		apiKeyClient(),
		deviceAuthorizationClient(),
		twoFactorClient({
			onTwoFactorRedirect: () => {
				window.location.href = getTwoFactorRedirectUrl();
			},
		}),
	],
});

export const { signIn, signUp, signOut, useSession } = authClient;
