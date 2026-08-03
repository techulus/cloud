import { createHash } from "node:crypto";
import {
	deliverNotificationEmail,
	getNotificationEmailRecipients,
} from "@/lib/email";
import { inngest } from "@/lib/inngest/client";
import { inngestEvents } from "@/lib/inngest/events";
import { deliverInAppNotification } from "@/lib/notifications";

export const notificationDelivery = inngest.createFunction(
	{
		id: "notification-delivery",
		triggers: [inngestEvents.notificationRequested],
	},
	async ({ event, step }) => {
		const initialResults = await Promise.allSettled([
			step.run("deliver-in-app", () => deliverInAppNotification(event.data)),
			step.run("resolve-email-recipients", () =>
				getNotificationEmailRecipients(event.data),
			),
		]);
		const recipientResult = initialResults[1];
		const emailResults =
			recipientResult.status === "fulfilled"
				? await Promise.allSettled(
						recipientResult.value.map((recipient) => {
							const recipientId = createHash("sha256")
								.update(recipient)
								.digest("hex")
								.slice(0, 16);
							return step.run(`deliver-email-${recipientId}`, () =>
								deliverNotificationEmail(event.data, recipient),
							);
						}),
					)
				: [];
		const failure = [...initialResults, ...emailResults].find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failure) throw failure.reason;
	},
);
