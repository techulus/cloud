import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "")
	.split(",")
	.map((value) => value.trim())
	.filter(Boolean);

const nextConfig: NextConfig = {
	output: "standalone",
	allowedDevOrigins,
};

export default nextConfig;
