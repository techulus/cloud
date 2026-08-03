import { render } from "@react-email/render";
import { and, eq, gt } from "drizzle-orm";
import type { Transporter } from "nodemailer";
import nodemailer from "nodemailer";
import type { ReactElement } from "react";
import { db } from "@/db";
import { getEmailAlertsConfig, getSmtpConfig } from "@/db/queries";
import {
	environments,
	memberInvitations,
	projects,
	servers,
	services,
} from "@/db/schema";
import { formatDateTimeUtc } from "@/lib/date";
import type { NotificationEvent } from "@/lib/inngest/events/notification";
import type { SmtpConfig } from "@/lib/settings-keys";
import { Alert } from "./templates/alert";
import { MemberInvitation } from "./templates/member-invitation";

function getAppBaseUrl(): string | undefined {
	return process.env.APP_URL;
}

function createTransporter(config: SmtpConfig): Transporter {
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

type SendEmailOptions = {
	to: string;
	subject: string;
	template: ReactElement;
};

async function sendEmail(
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

type MemberInviteEmailOptions = {
	to: string;
	inviterName: string;
	role: string;
	inviteUrl: string;
};

async function sendMemberInviteEmail(
	options: MemberInviteEmailOptions,
): Promise<boolean> {
	const config = getSmtpConfig();
	let baseUrl = getAppBaseUrl();

	if (!config?.enabled) {
		return false;
	}

	if (!baseUrl) {
		baseUrl = new URL(options.inviteUrl).origin;
	}

	await sendEmail(config, {
		to: options.to,
		subject: "You have been invited to Techulus Cloud",
		template: MemberInvitation({
			inviterName: options.inviterName,
			role: options.role,
			inviteUrl: options.inviteUrl,
			baseUrl,
		}),
	});

	return true;
}

function parseAlertEmails(alertEmails: string): string[] {
	return alertEmails
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);
}

type AlertOptions = {
	to: string;
	subject: string;
	template: ReactElement;
};

async function sendAlert(options: AlertOptions): Promise<void> {
	const config = getSmtpConfig();

	if (!config?.enabled) {
		return;
	}

	await sendEmail(config, options);
}

type ServerOfflineAlertOptions = {
	to: string;
	serverName: string;
	serverIp?: string;
};

async function sendServerOfflineAlert(
	options: ServerOfflineAlertOptions,
): Promise<void> {
	const baseUrl = getAppBaseUrl();
	const dashboardUrl = baseUrl ? `${baseUrl}/dashboard` : undefined;

	const details = [
		{ label: "Server Name", value: options.serverName },
		...(options.serverIp
			? [{ label: "IP Address", value: options.serverIp }]
			: []),
		{ label: "Detected At", value: formatDateTimeUtc(new Date()) },
	];

	await sendAlert({
		to: options.to,
		subject: `Alert: Server "${options.serverName}" is offline`,
		template: Alert({
			bannerText: "SERVER OFFLINE",
			heading: "Server Offline Alert",
			description: `The server "${options.serverName}" has gone offline and is no longer responding to health checks.`,
			details,
			note: "Services with replicas placed on this server require manual recovery or placement changes.",
			buttonText: dashboardUrl ? "View Dashboard" : undefined,
			buttonUrl: dashboardUrl,
			baseUrl,
		}),
	});
}

type ManualRecoveryRequiredAlertOptions = {
	to: string;
	serverId: string;
	serverName: string;
	serverIp?: string;
	impactedReplicas: number;
	serviceNames: string[];
};

async function sendManualRecoveryRequiredAlert(
	options: ManualRecoveryRequiredAlertOptions,
): Promise<void> {
	const baseUrl = getAppBaseUrl();
	const serverUrl = baseUrl
		? `${baseUrl}/dashboard/servers/${options.serverId}`
		: undefined;
	const serviceSummary =
		options.serviceNames.length > 0
			? options.serviceNames.slice(0, 10).join(", ")
			: "(unknown)";

	const details = [
		{ label: "Server", value: options.serverName },
		...(options.serverIp
			? [{ label: "IP Address", value: options.serverIp }]
			: []),
		{ label: "Impacted Replicas", value: String(options.impactedReplicas) },
		{ label: "Services", value: serviceSummary },
		{ label: "Detected At", value: formatDateTimeUtc(new Date()) },
	];

	await sendAlert({
		to: options.to,
		subject: `Manual recovery required for "${options.serverName}"`,
		template: Alert({
			bannerText: "MANUAL RECOVERY REQUIRED",
			heading: "Manual Recovery Required",
			description: `${options.impactedReplicas} active replica${options.impactedReplicas === 1 ? "" : "s"} were running on "${options.serverName}" when it went offline. Automatic recovery is disabled, so placement or recovery must be handled manually.`,
			details,
			buttonText: serverUrl ? "View Server" : undefined,
			buttonUrl: serverUrl,
			baseUrl,
		}),
	});
}

type BuildFailureAlertOptions = {
	to: string;
	serviceId: string;
	buildId: string;
	error?: string;
};

async function sendBuildFailureAlert(
	options: BuildFailureAlertOptions,
): Promise<void> {
	const [result] = await db
		.select({
			serviceName: services.name,
			projectName: projects.name,
			projectSlug: projects.slug,
			envName: environments.name,
		})
		.from(services)
		.innerJoin(projects, eq(projects.id, services.projectId))
		.innerJoin(environments, eq(environments.id, services.environmentId))
		.where(eq(services.id, options.serviceId));

	if (!result) {
		return;
	}

	const baseUrl = getAppBaseUrl();
	const buildUrl = baseUrl
		? `${baseUrl}/dashboard/projects/${result.projectSlug}/${result.envName}/services/${options.serviceId}/builds/${options.buildId}`
		: undefined;

	const details = [
		{ label: "Service", value: result.serviceName },
		{ label: "Project", value: result.projectName },
		{ label: "Build ID", value: options.buildId.slice(0, 8) },
		...(options.error ? [{ label: "Error", value: options.error }] : []),
	];

	await sendAlert({
		to: options.to,
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
	to: string;
	serviceId: string;
	serverId: string | null;
	failedStage?: string;
};

async function sendDeploymentFailureAlert(
	options: DeploymentFailureAlertOptions,
): Promise<void> {
	let serviceName: string;
	let projectName: string;
	let projectSlug: string;
	let envName: string;
	let serverName: string;

	if (options.serverId) {
		const [result] = await db
			.select({
				serviceName: services.name,
				projectName: projects.name,
				projectSlug: projects.slug,
				envName: environments.name,
				serverName: servers.name,
			})
			.from(services)
			.innerJoin(projects, eq(projects.id, services.projectId))
			.innerJoin(environments, eq(environments.id, services.environmentId))
			.innerJoin(servers, eq(servers.id, options.serverId))
			.where(eq(services.id, options.serviceId));

		if (!result) {
			return;
		}

		serviceName = result.serviceName;
		projectName = result.projectName;
		projectSlug = result.projectSlug;
		envName = result.envName;
		serverName = result.serverName;
	} else {
		const [result] = await db
			.select({
				serviceName: services.name,
				projectName: projects.name,
				projectSlug: projects.slug,
				envName: environments.name,
			})
			.from(services)
			.innerJoin(projects, eq(projects.id, services.projectId))
			.innerJoin(environments, eq(environments.id, services.environmentId))
			.where(eq(services.id, options.serviceId));

		if (!result) {
			return;
		}

		serviceName = result.serviceName;
		projectName = result.projectName;
		projectSlug = result.projectSlug;
		envName = result.envName;
		serverName = "Unknown";
	}
	const baseUrl = getAppBaseUrl();
	const serviceUrl = baseUrl
		? `${baseUrl}/dashboard/projects/${projectSlug}/${envName}/services/${options.serviceId}`
		: undefined;

	const details = [
		{ label: "Service", value: serviceName },
		{ label: "Project", value: projectName },
		{ label: "Server", value: serverName },
		...(options.failedStage
			? [{ label: "Failed Stage", value: options.failedStage }]
			: []),
	];

	await sendAlert({
		to: options.to,
		subject: `Deployment Failed: ${serviceName}`,
		template: Alert({
			bannerText: "DEPLOYMENT FAILED",
			heading: "Deployment Failure Alert",
			description: `The deployment for service "${serviceName}" in project "${projectName}" has failed on server "${serverName}".`,
			details,
			buttonText: serviceUrl ? "View Service" : undefined,
			buttonUrl: serviceUrl,
			baseUrl,
		}),
	});
}

export async function getNotificationEmailRecipients(
	event: NotificationEvent,
): Promise<string[]> {
	const config = getSmtpConfig();
	if (!config?.enabled) return [];

	if (event.kind === "member.invited") return [event.to];

	const alertsConfig = await getEmailAlertsConfig();
	const enabled =
		(event.kind === "server.offline" &&
			alertsConfig?.serverOfflineAlert !== false) ||
		(event.kind === "manual_recovery.required" &&
			alertsConfig?.deploymentMovedAlert !== false) ||
		(event.kind === "build.failed" && alertsConfig?.buildFailure !== false) ||
		(event.kind === "deployment.failed" &&
			alertsConfig?.deploymentFailure !== false);
	return enabled ? parseAlertEmails(config.alertEmails) : [];
}

async function invitationIsDeliverable(event: NotificationEvent) {
	if (event.kind !== "member.invited") return true;
	const [pendingInvitation] = await db
		.select({ id: memberInvitations.id })
		.from(memberInvitations)
		.where(
			and(
				eq(memberInvitations.id, event.occurrenceId),
				eq(memberInvitations.status, "pending"),
				gt(memberInvitations.expiresAt, new Date()),
			),
		)
		.limit(1);
	return Boolean(pendingInvitation);
}

export async function deliverNotificationEmail(
	event: NotificationEvent,
	to: string,
): Promise<void> {
	switch (event.kind) {
		case "member.invited":
			if (!(await invitationIsDeliverable(event))) return;
			await sendMemberInviteEmail({ ...event, to });
			return;
		case "server.offline":
			await sendServerOfflineAlert({ ...event, to });
			return;
		case "manual_recovery.required":
			await sendManualRecoveryRequiredAlert({ ...event, to });
			return;
		case "build.failed":
			await sendBuildFailureAlert({ ...event, to });
			return;
		case "deployment.failed":
			await sendDeploymentFailureAlert({ ...event, to });
	}
}
