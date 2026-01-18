import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { SmtpConfig } from "@/lib/settings-keys";
import { render } from "@react-email/render";
import type { ReactElement } from "react";
import { getSmtpConfig } from "@/db/queries";
import { ServerOfflineAlert } from "./templates/server-offline-alert";

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
	const baseUrl = getAppBaseUrl();
	const dashboardUrl = baseUrl ? `${baseUrl}/dashboard/servers` : undefined;

	await sendAlert({
		subject: `Alert: Server "${options.serverName}" is offline`,
		template: ServerOfflineAlert({
			serverName: options.serverName,
			serverIp: options.serverIp,
			detectedAt: new Date(),
			dashboardUrl,
			baseUrl,
		}),
	});
}
