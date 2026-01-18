import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { SmtpConfig } from "@/lib/settings-keys";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { getSmtpConfig, getEmailAlertsConfig } from "@/db/queries";
import { Alert } from "./templates/alert";
import { db } from "@/db";
import { services, projects, servers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { formatDateTime } from "@/lib/date";

export function getAppBaseUrl(): string | undefined {
	return process.env.NEXT_PUBLIC_APP_URL;
}

export function createTransporter(config: SmtpConfig): Transporter {
	const secure = config.encryption === "tls";
	const requireTLS = config.encryption === "starttls";

	return nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure,
		requireTLS,
		auth: {
			user: config.username,
			pass: config.password,
		},
		connectionTimeout: config.timeout,
		greetingTimeout: config.timeout,
		socketTimeout: config.timeout,
	});
}

export async function verifyConnection(config: SmtpConfig): Promise<boolean> {
	const transporter = createTransporter(config);
	try {
		await transporter.verify();
		return true;
	} finally {
		transporter.close();
	}
}

type SendEmailOptions = {
	to: string;
	subject: string;
	template: ReactElement;
};

export async function sendEmail(
	config: SmtpConfig,
	options: SendEmailOptions,
): Promise<void> {
	const transporter = createTransporter(config);

	try {
		const html = await render(options.template);

		await transporter.sendMail({
			from: `"${config.fromName}" <${config.fromAddress}>`,
			to: options.to,
			subject: options.subject,
			html,
		});
	} finally {
		transporter.close();
	}
}

function parseAlertEmails(alertEmails: string): string[] {
	return alertEmails
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
}

type AlertOptions = {
	subject: string;
	template: ReactElement;
};

export async function sendAlert(options: AlertOptions): Promise<void> {
	const config = await getSmtpConfig();

	if (!config?.enabled || !config.alertEmails) {
		return;
	}

	const recipients = parseAlertEmails(config.alertEmails);
	if (recipients.length === 0) {
		return;
	}

	await Promise.all(
		recipients.map((email) =>
			sendEmail(config, {
				to: email,
				subject: options.subject,
				template: options.template,
			}),
		),
	);
}

type ServerOfflineAlertOptions = {
	serverName: string;
	serverIp?: string;
};

export async function sendServerOfflineAlert(
	options: ServerOfflineAlertOptions,
): Promise<void> {
	const alertsConfig = await getEmailAlertsConfig();

	if (alertsConfig?.serverOfflineAlert === false) {
		return;
	}

	const baseUrl = getAppBaseUrl();
	const dashboardUrl = baseUrl ? `${baseUrl}/dashboard` : undefined;

	const details = [
		{ label: "Server Name", value: options.serverName },
		...(options.serverIp
			? [{ label: "IP Address", value: options.serverIp }]
			: []),
		{ label: "Detected At", value: formatDateTime(new Date()) },
	];

	await sendAlert({
		subject: `Alert: Server "${options.serverName}" is offline`,
		template: Alert({
			bannerText: "SERVER OFFLINE",
			heading: "Server Offline Alert",
			description: `The server "${options.serverName}" has gone offline and is no longer responding to health checks.`,
			details,
			note: "Auto-placed stateless services running on this server will be automatically recovered and redeployed to healthy servers.",
			buttonText: dashboardUrl ? "View Dashboard" : undefined,
			buttonUrl: dashboardUrl,
			baseUrl,
		}),
	});
}

type BuildFailureAlertOptions = {
	serviceId: string;
	buildId: string;
	error?: string;
};

export async function sendBuildFailureAlert(
	options: BuildFailureAlertOptions,
): Promise<void> {
	const alertsConfig = await getEmailAlertsConfig();

	if (alertsConfig?.buildFailure === false) {
		return;
	}

	const [result] = await db
		.select({
			serviceName: services.name,
			projectName: projects.name,
		})
		.from(services)
		.innerJoin(projects, eq(projects.id, services.projectId))
		.where(eq(services.id, options.serviceId));

	if (!result) {
		return;
	}

	const baseUrl = getAppBaseUrl();
	const buildUrl = baseUrl
		? `${baseUrl}/builds/${options.buildId}/logs`
		: undefined;

	const details = [
		{ label: "Service", value: result.serviceName },
		{ label: "Project", value: result.projectName },
		{ label: "Build ID", value: options.buildId.slice(0, 8) },
		...(options.error ? [{ label: "Error", value: options.error }] : []),
	];

	await sendAlert({
		subject: `Build Failed: ${result.serviceName}`,
		template: Alert({
			bannerText: "BUILD FAILED",
			heading: "Build Failure Alert",
			description: `The build for service "${result.serviceName}" in project "${result.projectName}" has failed.`,
			details,
			buttonText: buildUrl ? "View Build Logs" : undefined,
			buttonUrl: buildUrl,
			baseUrl,
		}),
	});
}

type DeploymentFailureAlertOptions = {
	serviceId: string;
	serverId: string;
	failedStage?: string;
};

export async function sendDeploymentFailureAlert(
	options: DeploymentFailureAlertOptions,
): Promise<void> {
	const alertsConfig = await getEmailAlertsConfig();

	if (alertsConfig?.deploymentFailure === false) {
		return;
	}

	const [result] = await db
		.select({
			serviceName: services.name,
			projectName: projects.name,
			serverName: servers.name,
		})
		.from(services)
		.innerJoin(projects, eq(projects.id, services.projectId))
		.innerJoin(servers, eq(servers.id, options.serverId))
		.where(eq(services.id, options.serviceId));

	if (!result) {
		return;
	}

	const baseUrl = getAppBaseUrl();
	const dashboardUrl = baseUrl ? `${baseUrl}/dashboard` : undefined;

	const details = [
		{ label: "Service", value: result.serviceName },
		{ label: "Project", value: result.projectName },
		{ label: "Server", value: result.serverName },
		...(options.failedStage
			? [{ label: "Failed Stage", value: options.failedStage }]
			: []),
	];

	await sendAlert({
		subject: `Deployment Failed: ${result.serviceName}`,
		template: Alert({
			bannerText: "DEPLOYMENT FAILED",
			heading: "Deployment Failure Alert",
			description: `The deployment for service "${result.serviceName}" in project "${result.projectName}" has failed on server "${result.serverName}".`,
			details,
			buttonText: dashboardUrl ? "View Dashboard" : undefined,
			buttonUrl: dashboardUrl,
			baseUrl,
		}),
	});
}
