import db from "@/db";
import { service } from "@/db/schema";
import { FlyClient } from "@/lib/fly";
import { logger, task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";

export const deployServiceJob = task({
	id: "deploy-service",
	maxDuration: 300,
	run: async (payload: { serviceId: string }, { ctx }) => {
		logger.log("Starting service deployment", { payload, ctx });

		const { serviceId } = payload;

		const fly = new FlyClient();

		await fly.delete(`/apps/${serviceId}`).catch((error) => {
			if (error.status === 404) {
				return null;
			}

			throw error;
		});

		await db.delete(service).where(eq(service.id, serviceId));

		return {
			message: "Service deleted successfully",
		};
	},
});
