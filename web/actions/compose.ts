"use server";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { services } from "@/db/schema";
import { parseComposeYaml, type ParsedService } from "@/lib/compose-parser";
import {
	createService,
	validateDockerImage,
	updateServiceHealthCheck,
	updateServiceResourceLimits,
	updateServiceStartCommand,
	addServiceVolume,
} from "./projects";
import { createSecretsBatch } from "./secrets";

export type ServiceOverride = {
	name?: string;
	stateful?: boolean;
};

export type ImportComposeInput = {
	projectId: string;
	environmentId: string;
	yaml: string;
	serviceOverrides?: Record<string, ServiceOverride>;
};

export type ImportedService = {
	name: string;
	serviceId: string;
};

export type ImportComposeResult = {
	success: boolean;
	created: ImportedService[];
	warnings: Array<{ service?: string; field: string; message: string }>;
	errors: Array<{ service?: string; message: string }>;
};

export async function parseComposeFile(yaml: string) {
	return parseComposeYaml(yaml);
}

export async function importCompose(
	input: ImportComposeInput,
): Promise<ImportComposeResult> {
	const { projectId, environmentId, yaml, serviceOverrides = {} } = input;

	const parseResult = parseComposeYaml(yaml);
	const warnings = [...parseResult.warnings];
	const errors = [...parseResult.errors];

	if (!parseResult.success) {
		return {
			success: false,
			created: [],
			warnings,
			errors,
		};
	}

	const existingServices = await db
		.select({ name: services.name })
		.from(services)
		.where(
			and(eq(services.projectId, projectId), eq(services.environmentId, environmentId)),
		);

	const existingNames = new Set(existingServices.map((s) => s.name.toLowerCase()));

	for (const service of parseResult.services) {
		const overrideName = serviceOverrides[service.name]?.name;
		const finalName = overrideName || service.name;

		if (existingNames.has(finalName.toLowerCase())) {
			errors.push({
				service: service.name,
				message: `Service '${finalName}' already exists in this environment`,
			});
		}
	}

	const imageValidations = await Promise.all(
		parseResult.services.map(async (service) => {
			const result = await validateDockerImage(service.image);
			return { service: service.name, image: service.image, ...result };
		}),
	);

	for (const validation of imageValidations) {
		if (!validation.valid) {
			errors.push({
				service: validation.service,
				message: `Invalid image '${validation.image}': ${validation.error || "Image not found"}`,
			});
		}
	}

	if (errors.length > 0) {
		return {
			success: false,
			created: [],
			warnings,
			errors,
		};
	}

	const created: ImportedService[] = [];
	const createdServiceIds: string[] = [];

	try {
		for (const service of parseResult.services) {
			const override = serviceOverrides[service.name] || {};
			const finalName = override.name || service.name;
			const finalStateful =
				override.stateful !== undefined ? override.stateful : service.stateful;

			const result = await createService({
				projectId,
				environmentId,
				name: finalName,
				image: service.image,
				stateful: finalStateful,
			});

			createdServiceIds.push(result.id);
			created.push({ name: finalName, serviceId: result.id });

			if (service.environment.length > 0) {
				await createSecretsBatch(result.id, service.environment);
			}

			if (finalStateful && service.volumes.length > 0) {
				for (const volume of service.volumes) {
					try {
						await addServiceVolume(result.id, volume.name, volume.containerPath);
					} catch (e) {
						warnings.push({
							service: finalName,
							field: "volumes",
							message: `Failed to add volume '${volume.name}': ${e instanceof Error ? e.message : "Unknown error"}`,
						});
					}
				}
			}

			if (service.healthCheck) {
				await updateServiceHealthCheck(result.id, service.healthCheck);
			}

			if (service.startCommand) {
				await updateServiceStartCommand(result.id, service.startCommand);
			}

			if (service.resourceCpuLimit !== null && service.resourceMemoryLimitMb !== null) {
				await updateServiceResourceLimits(result.id, {
					cpuCores: service.resourceCpuLimit,
					memoryMb: service.resourceMemoryLimitMb,
				});
			}
		}

		return {
			success: true,
			created,
			warnings,
			errors: [],
		};
	} catch (error) {
		for (const serviceId of createdServiceIds) {
			try {
				await db.delete(services).where(eq(services.id, serviceId));
			} catch {
			}
		}

		return {
			success: false,
			created: [],
			warnings,
			errors: [
				{
					message: `Import failed: ${error instanceof Error ? error.message : "Unknown error"}`,
				},
			],
		};
	}
}
