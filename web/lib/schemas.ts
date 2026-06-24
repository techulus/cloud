import { z } from "zod";

export const nameSchema = z
	.string()
	.min(1, "Name is required")
	.max(100, "Name must be 100 characters or less")
	.transform((val) => val.trim())
	.refine((val) => val.length > 0, "Name cannot be empty");

export const volumeNameSchema = z
	.string()
	.min(1, "Volume name is required")
	.max(64, "Volume name must be 64 characters or less")
	.transform((val) => val.toLowerCase().replace(/[^a-z0-9-]/g, "-"))
	.refine((val) => val.length > 0, "Invalid volume name");

export const containerPathSchema = z
	.string()
	.min(1, "Container path is required")
	.transform((val) => val.trim())
	.refine(
		(val) => val.startsWith("/"),
		"Container path must be an absolute path",
	);

export const githubRepoUrlSchema = z
	.string()
	.transform((val) => val.trim())
	.refine(
		(val) => val.startsWith("https://github.com/"),
		"Repository URL must be a GitHub URL (https://github.com/...)",
	);

const secretItemSchema = z.object({
	key: z.string().min(1, "Key is required"),
	value: z.string().min(1, "Value is required"),
});

export const secretItemArraySchema = z.array(secretItemSchema);

export const agentRegisterSchema = z.object({
	token: z.string().min(1, "Token is required"),
	wireguardPublicKey: z.string().min(1, "WireGuard public key is required"),
	signingPublicKey: z.string().min(1, "Signing public key is required"),
	publicIp: z.string().nullable().optional(),
	privateIp: z.string().nullable().optional(),
	isProxy: z.boolean().optional(),
});

export const buildTimeoutSchema = z
	.number()
	.int("Timeout must be a whole number")
	.min(5, "Build timeout must be at least 5 minutes")
	.max(120, "Build timeout cannot exceed 120 minutes");
