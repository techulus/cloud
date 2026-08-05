import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const allowedDevOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
	.map((origin) => origin.trim())
	.filter(Boolean);

const nextConfig: NextConfig = {
	output: "standalone",
	...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
};

export default withSentryConfig(nextConfig, {
	release: { create: false },
	routeManifestInjection: false,
	silent: true,
	sourcemaps: { disable: true },
	telemetry: false,
});
