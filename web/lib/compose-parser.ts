import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { formatZodErrors } from "@/lib/utils";

const composeHealthcheckSchema = z.object({
	test: z.union([z.string(), z.array(z.string())]).optional(),
	interval: z.string().optional(),
	timeout: z.string().optional(),
	retries: z.number().optional(),
	start_period: z.string().optional(),
});

const composeDeployResourcesSchema = z.object({
	limits: z
		.object({
			cpus: z.union([z.string(), z.number()]).optional(),
			memory: z.string().optional(),
		})
		.optional(),
});

const composeDeploySchema = z.object({
	replicas: z.number().optional(),
	resources: composeDeployResourcesSchema.optional(),
});

const composeServiceSchema = z.object({
	image: z.string().optional(),
	build: z.any().optional(),
	ports: z.array(z.union([z.string(), z.number()])).optional(),
	environment: z
		.union([z.array(z.string()), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))])
		.optional(),
	volumes: z.array(z.string()).optional(),
	healthcheck: composeHealthcheckSchema.optional(),
	command: z.union([z.string(), z.array(z.string())]).optional(),
	entrypoint: z.union([z.string(), z.array(z.string())]).optional(),
	deploy: composeDeploySchema.optional(),
	depends_on: z.any().optional(),
	networks: z.any().optional(),
	privileged: z.boolean().optional(),
	cap_add: z.array(z.string()).optional(),
	cap_drop: z.array(z.string()).optional(),
	env_file: z.any().optional(),
	restart: z.string().optional(),
});

const composeFileSchema = z.object({
	version: z.string().optional(),
	services: z.record(z.string(), composeServiceSchema),
	volumes: z.record(z.string(), z.any()).optional(),
	networks: z.record(z.string(), z.any()).optional(),
});

export type ParsedPort = {
	port: number;
	protocol: "http" | "tcp" | "udp";
};

export type ParsedVolume = {
	name: string;
	containerPath: string;
};

export type ParsedHealthCheck = {
	cmd: string;
	interval: number;
	timeout: number;
	retries: number;
	startPeriod: number;
};

export type ParsedService = {
	name: string;
	image: string;
	stateful: boolean;
	ports: ParsedPort[];
	environment: { key: string; value: string }[];
	volumes: ParsedVolume[];
	healthCheck: ParsedHealthCheck | null;
	replicas: number;
	resourceCpuLimit: number | null;
	resourceMemoryLimitMb: number | null;
	startCommand: string | null;
};

export type ParseWarning = {
	service?: string;
	field: string;
	message: string;
};

export type ParseError = {
	service?: string;
	message: string;
};

export type ComposeParseResult = {
	success: boolean;
	services: ParsedService[];
	warnings: ParseWarning[];
	errors: ParseError[];
};

function parseDuration(duration: string): number {
	const match = duration.match(/^(\d+)(s|m|h|ms)?$/);
	if (!match) return 0;

	const value = Number.parseInt(match[1], 10);
	const unit = match[2] || "s";

	switch (unit) {
		case "ms":
			return Math.max(1, Math.floor(value / 1000));
		case "s":
			return value;
		case "m":
			return value * 60;
		case "h":
			return value * 3600;
		default:
			return value;
	}
}

function parseMemory(memory: string): number {
	const match = memory.match(/^(\d+(?:\.\d+)?)(b|k|kb|m|mb|g|gb)?$/i);
	if (!match) return 0;

	const value = Number.parseFloat(match[1]);
	const unit = (match[2] || "b").toLowerCase();

	switch (unit) {
		case "b":
			return Math.ceil(value / (1024 * 1024));
		case "k":
		case "kb":
			return Math.ceil(value / 1024);
		case "m":
		case "mb":
			return Math.ceil(value);
		case "g":
		case "gb":
			return Math.ceil(value * 1024);
		default:
			return Math.ceil(value);
	}
}

function parsePort(
	portString: string | number,
	serviceName: string,
): { port: ParsedPort | null; error: string | null } {
	const str = String(portString);

	const protocolMatch = str.match(/\/(tcp|udp)$/i);
	const protocol = protocolMatch
		? (protocolMatch[1].toLowerCase() as "tcp" | "udp")
		: "http";
	const portPart = protocolMatch ? str.slice(0, -protocolMatch[0].length) : str;

	const parts = portPart.split(":");

	let containerPort: number;

	if (parts.length === 1) {
		containerPort = Number.parseInt(parts[0], 10);
	} else if (parts.length === 2) {
		containerPort = Number.parseInt(parts[1], 10);
	} else if (parts.length === 3) {
		containerPort = Number.parseInt(parts[2], 10);
	} else {
		return {
			port: null,
			error: `Service '${serviceName}' has invalid port format: '${str}'. Expected formats: '80', '8080:80', or '8080:80/tcp'`,
		};
	}

	if (Number.isNaN(containerPort) || containerPort < 1 || containerPort > 65535) {
		return {
			port: null,
			error: `Service '${serviceName}' has invalid port format: '${str}'. Expected formats: '80', '8080:80', or '8080:80/tcp'`,
		};
	}

	return {
		port: { port: containerPort, protocol },
		error: null,
	};
}

function parseVolume(
	volumeString: string,
	serviceName: string,
	definedVolumes: Set<string>,
): { volume: ParsedVolume | null; warning: string | null; error: string | null } {
	const parts = volumeString.split(":");

	if (parts.length < 2) {
		return {
			volume: null,
			warning: null,
			error: `Service '${serviceName}' has invalid volume format: '${volumeString}'. Expected format: 'volume_name:/container/path'`,
		};
	}

	const source = parts[0];
	const containerPath = parts[1];

	if (!containerPath.startsWith("/")) {
		return {
			volume: null,
			warning: null,
			error: `Service '${serviceName}' has invalid volume format: '${volumeString}'. Container path must be absolute.`,
		};
	}

	if (source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
		return {
			volume: null,
			warning: `Bind mount '${source}' ignored. Only named volumes are supported.`,
			error: null,
		};
	}

	if (!definedVolumes.has(source) && !source.match(/^[a-zA-Z][a-zA-Z0-9_-]*$/)) {
		return {
			volume: null,
			warning: `Bind mount '${source}' ignored. Only named volumes are supported.`,
			error: null,
		};
	}

	return {
		volume: {
			name: source.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
			containerPath,
		},
		warning: null,
		error: null,
	};
}

function parseEnvironment(
	env: string[] | Record<string, string | number | boolean | null> | undefined,
): { key: string; value: string }[] {
	if (!env) return [];

	if (Array.isArray(env)) {
		return env
			.map((item) => {
				const eqIndex = item.indexOf("=");
				if (eqIndex === -1) {
					return { key: item, value: "" };
				}
				return {
					key: item.slice(0, eqIndex),
					value: item.slice(eqIndex + 1),
				};
			})
			.filter((item) => item.key);
	}

	return Object.entries(env)
		.map(([key, value]) => ({
			key,
			value: value === null ? "" : String(value),
		}))
		.filter((item) => item.key);
}

function parseHealthcheck(
	hc: z.infer<typeof composeHealthcheckSchema> | undefined,
): ParsedHealthCheck | null {
	if (!hc || !hc.test) return null;

	let cmd: string;
	if (Array.isArray(hc.test)) {
		const testArr = hc.test;
		if (testArr[0] === "CMD" || testArr[0] === "CMD-SHELL") {
			cmd = testArr.slice(1).join(" ");
		} else if (testArr[0] === "NONE") {
			return null;
		} else {
			cmd = testArr.join(" ");
		}
	} else {
		cmd = hc.test;
	}

	return {
		cmd,
		interval: hc.interval ? parseDuration(hc.interval) : 10,
		timeout: hc.timeout ? parseDuration(hc.timeout) : 5,
		retries: hc.retries ?? 3,
		startPeriod: hc.start_period ? parseDuration(hc.start_period) : 30,
	};
}

function quoteIfNeeded(arg: string): string {
	if (arg.includes(" ") || arg.includes('"') || arg.includes("'")) {
		return `"${arg.replace(/"/g, '\\"')}"`;
	}
	return arg;
}

function parseStartCommand(
	entrypoint: string | string[] | undefined,
	command: string | string[] | undefined,
): string | null {
	const ep = entrypoint
		? Array.isArray(entrypoint)
			? entrypoint.map(quoteIfNeeded).join(" ")
			: entrypoint
		: null;
	const cmd = command
		? Array.isArray(command)
			? command.map(quoteIfNeeded).join(" ")
			: command
		: null;

	if (ep && cmd) return `${ep} ${cmd}`;
	if (ep) return ep;
	if (cmd) return cmd;
	return null;
}

export function parseComposeYaml(yamlContent: string): ComposeParseResult {
	const warnings: ParseWarning[] = [];
	const errors: ParseError[] = [];
	const services: ParsedService[] = [];

	let parsed: unknown;
	try {
		parsed = parseYaml(yamlContent, { merge: true });
	} catch (e) {
		const message = e instanceof Error ? e.message : "Unknown error";
		return {
			success: false,
			services: [],
			warnings: [],
			errors: [{ message: `Invalid YAML: ${message}` }],
		};
	}

	const validated = composeFileSchema.safeParse(parsed);
	if (!validated.success) {
		return {
			success: false,
			services: [],
			warnings: [],
			errors: [{ message: `Invalid Docker Compose file: ${formatZodErrors(validated.error)}` }],
		};
	}

	const composeFile = validated.data;

	if (!composeFile.services || Object.keys(composeFile.services).length === 0) {
		return {
			success: false,
			services: [],
			warnings: [],
			errors: [{ message: "Docker Compose file must contain a 'services' section" }],
		};
	}

	const definedVolumes = new Set(Object.keys(composeFile.volumes || {}));

	for (const [serviceName, serviceConfig] of Object.entries(composeFile.services)) {
		const isTemplateService =
			!serviceConfig.command &&
			!serviceConfig.entrypoint &&
			!serviceConfig.ports?.length;

		if (isTemplateService) {
			warnings.push({
				service: serviceName,
				field: "service",
				message: `Service '${serviceName}' appears to be a YAML anchor template (no command, entrypoint, or ports). Skipping.`,
			});
			continue;
		}

		if (!serviceConfig.image && serviceConfig.build) {
			errors.push({
				service: serviceName,
				message: `Service '${serviceName}' uses 'build' without an 'image'. Only pre-built images are supported. Please build and push the image first, then specify it in the 'image' field.`,
			});
			continue;
		}

		if (!serviceConfig.image) {
			errors.push({
				service: serviceName,
				message: `Service '${serviceName}' must have an 'image' field`,
			});
			continue;
		}

		if (serviceConfig.build && serviceConfig.image) {
			warnings.push({
				service: serviceName,
				field: "build",
				message: "Build configuration ignored. Using specified image.",
			});
		}

		if (serviceConfig.depends_on) {
			warnings.push({
				service: serviceName,
				field: "depends_on",
				message: "Service dependencies ignored. Services will start independently.",
			});
		}

		if (serviceConfig.networks) {
			warnings.push({
				service: serviceName,
				field: "networks",
				message: "Custom networks ignored. Services use internal mesh networking.",
			});
		}

		if (serviceConfig.privileged || serviceConfig.cap_add || serviceConfig.cap_drop) {
			warnings.push({
				service: serviceName,
				field: "privileged/cap_add/cap_drop",
				message: "Privileged mode and capabilities ignored for security.",
			});
		}

		if (serviceConfig.env_file) {
			warnings.push({
				service: serviceName,
				field: "env_file",
				message: "env_file ignored. Please add environment variables inline.",
			});
		}

		if (serviceConfig.restart) {
			warnings.push({
				service: serviceName,
				field: "restart",
				message: "Restart policy ignored. Platform manages restarts automatically.",
			});
		}

		const parsedPorts: ParsedPort[] = [];
		for (const portDef of serviceConfig.ports || []) {
			const result = parsePort(portDef, serviceName);
			if (result.error) {
				errors.push({ service: serviceName, message: result.error });
			} else if (result.port) {
				if (!parsedPorts.some((p) => p.port === result.port!.port && p.protocol === result.port!.protocol)) {
					parsedPorts.push(result.port);
				}
			}
		}

		const parsedVolumes: ParsedVolume[] = [];
		for (const volumeDef of serviceConfig.volumes || []) {
			const result = parseVolume(volumeDef, serviceName, definedVolumes);
			if (result.error) {
				errors.push({ service: serviceName, message: result.error });
			} else if (result.warning) {
				warnings.push({
					service: serviceName,
					field: "volumes",
					message: result.warning,
				});
			} else if (result.volume) {
				if (!parsedVolumes.some((v) => v.name === result.volume!.name)) {
					parsedVolumes.push(result.volume);
				}
			}
		}

		const stateful = parsedVolumes.length > 0;

		let replicas = serviceConfig.deploy?.replicas ?? 1;
		if (replicas < 1) replicas = 1;
		if (replicas > 10) replicas = 10;
		if (stateful && replicas > 1) {
			warnings.push({
				service: serviceName,
				field: "deploy.replicas",
				message: `Replicas set to 1 for stateful service (has volumes). Requested: ${replicas}`,
			});
			replicas = 1;
		}

		let cpuLimit: number | null = null;
		let memoryLimit: number | null = null;

		const resources = serviceConfig.deploy?.resources?.limits;
		if (resources) {
			if (resources.cpus) {
				const cpuValue = typeof resources.cpus === "string" ? Number.parseFloat(resources.cpus) : resources.cpus;
				if (!Number.isNaN(cpuValue) && cpuValue >= 0.1 && cpuValue <= 64) {
					cpuLimit = cpuValue;
				}
			}
			if (resources.memory) {
				const memValue = parseMemory(resources.memory);
				if (memValue >= 64 && memValue <= 65536) {
					memoryLimit = memValue;
				}
			}
			if ((cpuLimit === null) !== (memoryLimit === null)) {
				cpuLimit = null;
				memoryLimit = null;
				warnings.push({
					service: serviceName,
					field: "deploy.resources.limits",
					message: "Resource limits ignored. Both CPU and memory must be set together.",
				});
			}
		}

		services.push({
			name: serviceName,
			image: serviceConfig.image,
			stateful,
			ports: parsedPorts,
			environment: parseEnvironment(serviceConfig.environment),
			volumes: parsedVolumes,
			healthCheck: parseHealthcheck(serviceConfig.healthcheck),
			replicas,
			resourceCpuLimit: cpuLimit,
			resourceMemoryLimitMb: memoryLimit,
			startCommand: parseStartCommand(serviceConfig.entrypoint, serviceConfig.command),
		});
	}

	return {
		success: errors.length === 0,
		services,
		warnings,
		errors,
	};
}
