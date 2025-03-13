import db from "@/db";
import { service } from "@/db/schema";
import { logger, task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";

export const deployServiceJob = task({
	id: "deploy-service",
	maxDuration: 300,
	run: async (payload: { serviceId: string }, { ctx }) => {
		logger.log("Starting service deployment", { payload, ctx });

		const { serviceId } = payload;

		const serviceDetails = await db.query.service.findFirst({
			where: eq(service.id, serviceId),
		});
		if (!serviceDetails) {
			throw new Error("Service not found");
		}

		logger.log("Service details", {
			serviceDetails,
		});

		return {
			message: "Service deployed successfully",
		};
	},
});
