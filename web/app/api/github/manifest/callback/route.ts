import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
	const searchParams = request.nextUrl.searchParams;
	const code = searchParams.get("code");

	if (!code) {
		return NextResponse.redirect(
			new URL("/dashboard/settings?github_error=missing_code", request.url),
		);
	}

	try {
		const response = await fetch(
			`https://api.github.com/app-manifests/${code}/conversions`,
			{
				method: "POST",
				headers: {
					Accept: "application/vnd.github+json",
				},
			},
		);

		if (!response.ok) {
			const error = await response.text();
			console.error("GitHub manifest conversion failed:", error);
			return NextResponse.redirect(
				new URL(
					"/dashboard/settings?github_error=conversion_failed",
					request.url,
				),
			);
		}

		const data = await response.json();

		const credentials = {
			id: data.id,
			slug: data.slug,
			pem: Buffer.from(data.pem).toString("base64"),
			webhookSecret: data.webhook_secret,
			ownerType: data.owner?.type,
			ownerLogin: data.owner?.login,
		};

		const credentialsParam = encodeURIComponent(JSON.stringify(credentials));

		return NextResponse.redirect(
			new URL(
				`/dashboard/settings?github_credentials=${credentialsParam}`,
				request.url,
			),
		);
	} catch (error) {
		console.error("GitHub manifest callback error:", error);
		return NextResponse.redirect(
			new URL("/dashboard/settings?github_error=unknown", request.url),
		);
	}
}
