import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const manifestPortSchema = z
	.object({
		port: z.number().int().min(1).max(65535),
		public: z.boolean().default(false),
		domain: z.string().trim().min(1).optional(),
	})
	.strict();

const manifestHealthCheckSchema = z
	.object({
		cmd: z.string().trim().min(1),
		interval: z.number().int().min(1).default(10),
		timeout: z.number().int().min(1).default(5),
		retries: z.number().int().min(1).default(3),
		startPeriod: z.number().int().min(0).default(30),
	})
	.strict();

const manifestResourcesSchema = z
	.object({
		cpuCores: z.number().min(0.1).max(64).nullable().optional(),
		memoryMb: z.number().int().min(64).max(65536).nullable().optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const hasCpu = value.cpuCores !== undefined && value.cpuCores !== null;
		const hasMemory = value.memoryMb !== undefined && value.memoryMb !== null;

		if (hasCpu !== hasMemory) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "resources must set both cpuCores and memoryMb together",
			});
		}
	});

export const techulusManifestSchema = z
	.object({
		apiVersion: z.literal("v1"),
		project: z.string().trim().min(1),
		environment: z.string().trim().min(1),
		service: z
			.object({
				name: z.string().trim().min(1),
				source: z
					.object({
						type: z.literal("image"),
						image: z.string().trim().min(1),
					})
					.strict(),
				hostname: z.string().trim().min(1).optional(),
				ports: z.array(manifestPortSchema).default([]),
				replicas: z
					.object({
						count: z.number().int().min(1).max(10).default(1),
					})
					.strict()
					.default({ count: 1 }),
				healthCheck: manifestHealthCheckSchema.optional(),
				startCommand: z.string().trim().min(1).optional(),
				resources: manifestResourcesSchema.optional(),
			})
			.strict(),
	})
	.strict();

export type TechulusManifest = z.infer<typeof techulusManifestSchema>;

export async function loadManifest(cwd: string) {
	const manifestPath = path.join(cwd, "techulus.yml");
	const raw = await readFile(manifestPath, "utf8");
	const parsed = YAML.parse(raw);
	return {
		path: manifestPath,
		manifest: techulusManifestSchema.parse(parsed),
	};
}

export function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
