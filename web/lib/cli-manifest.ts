import { z } from "zod";
import { slugify } from "@/lib/utils";

const manifestPortSchema = z
	.object({
		port: z.number().int().min(1).max(65535),
		public: z.boolean().default(false),
		domain: z.string().trim().min(1).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.public && !value.domain) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["domain"],
				message: "Public HTTP ports require a domain",
			});
		}

		if (!value.public && value.domain) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["domain"],
				message: "Internal ports cannot define a domain",
			});
		}
	});

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
				message: "Resources must set both cpuCores and memoryMb together",
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

export function getManifestProjectSlug(manifest: TechulusManifest) {
	return slugify(manifest.project);
}

export function getManifestEnvironmentName(manifest: TechulusManifest) {
	return slugify(manifest.environment);
}

export function getManifestServiceName(manifest: TechulusManifest) {
	return manifest.service.name.trim();
}
