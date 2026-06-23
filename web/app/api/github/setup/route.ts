import { createPrivateKey, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { githubInstallations } from "@/db/schema";
import { auth } from "@/lib/auth";

async function getInstallationDetails(installationId: number): Promise<{
	account: { login: string; type: "User" | "Organization" };
} | null> {
	const appId = process.env.GITHUB_APP_ID;
	const privateKeyBase64 = process.env.GITHUB_APP_PRIVATE_KEY;
	const privateKey = privateKeyBase64
		? Buffer.from(privateKeyBase64, "base64").toString("utf-8")
		: undefined;

	if (!appId || !privateKey) {
		return null;
	}

	const key = createPrivateKey(privateKey);
	const now = Math.floor(Date.now() / 1000);
	const jwt = await new SignJWT({})
		.setProtectedHeader({ alg: "RS256" })
		.setIssuedAt(now - 60)
		.setExpirationTime(now + 600)
		.setIssuer(appId)
		.sign(key);

	const response = await fetch(
		`https://api.github.com/app/installations/${installationId}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${jwt}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		console.error(
			`[github:setup] failed to get installation ${installationId}:`,
			await response.text(),
		);
		return null;
	}

	return response.json();
}

export async function GET(request: NextRequest) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		const loginUrl = new URL("/auth/login", request.url);
		loginUrl.searchParams.set("redirect", request.url);
		return NextResponse.redirect(loginUrl, 303);
	}

	const searchParams = request.nextUrl.searchParams;
	const installationIdParam = searchParams.get("installation_id");
	const setupAction = searchParams.get("setup_action");

	if (!installationIdParam) {
		return NextResponse.redirect(
			new URL("/dashboard?error=missing_installation_id", request.url),
		);
	}

	const installationId = parseInt(installationIdParam, 10);

	if (Number.isNaN(installationId)) {
		return NextResponse.redirect(
			new URL("/dashboard?error=invalid_installation_id", request.url),
		);
	}

	if (setupAction !== "install" && setupAction !== "update") {
		return NextResponse.redirect(
			new URL(`/dashboard?github_connected=true`, request.url),
		);
	}

	return new NextResponse(
		`<!doctype html>
<html>
<body>
<form method="post" action="/api/github/setup">
<input type="hidden" name="installation_id" value="${installationId}" />
<input type="hidden" name="setup_action" value="${setupAction}" />
<noscript><button type="submit">Continue GitHub setup</button></noscript>
</form>
<script>document.forms[0].submit()</script>
</body>
</html>`,
		{
			headers: { "content-type": "text/html; charset=utf-8" },
		},
	);
}

export async function POST(request: NextRequest) {
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		const loginUrl = new URL("/auth/login", request.url);
		loginUrl.searchParams.set("redirect", request.url);
		return NextResponse.redirect(loginUrl, 303);
	}

	const formData = await request.formData();
	const installationIdParam = formData.get("installation_id");
	const setupAction = formData.get("setup_action");

	if (typeof installationIdParam !== "string") {
		return NextResponse.redirect(
			new URL("/dashboard?error=missing_installation_id", request.url),
			303,
		);
	}

	const installationId = parseInt(installationIdParam, 10);

	if (Number.isNaN(installationId)) {
		return NextResponse.redirect(
			new URL("/dashboard?error=invalid_installation_id", request.url),
			303,
		);
	}

	if (setupAction === "install" || setupAction === "update") {
		const existingInstallation = await db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId))
			.then((r) => r[0]);

		if (existingInstallation) {
			return NextResponse.redirect(
				new URL(`/dashboard?github_connected=true`, request.url),
				303,
			);
		}

		const installation = await getInstallationDetails(installationId);

		if (!installation) {
			return NextResponse.redirect(
				new URL("/dashboard?error=github_fetch_failed", request.url),
				303,
			);
		}

		await db.insert(githubInstallations).values({
			id: randomUUID(),
			installationId,
			accountLogin: installation.account.login,
			accountType: installation.account.type,
			userId: session.user.id,
		});

		console.log(
			`[github:setup] created installation ${installationId} for user ${session.user.id}`,
		);
	}

	return NextResponse.redirect(
		new URL(`/dashboard?github_connected=true`, request.url),
		303,
	);
}
