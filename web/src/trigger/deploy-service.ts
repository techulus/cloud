import type { Machine } from "@/data/fly-types";
import db from "@/db";
import { service } from "@/db/schema";
import { FlyClient } from "@/lib/fly";
import { logger, task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";

const ORG_SLUG = "arjun-komath";

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

		const fly = new FlyClient();

		let app = await fly
			.get(`/apps/${serviceDetails.id}?org_slug=${ORG_SLUG}`)
			.catch((error) => {
				if (error.status === 404) {
					return null;
				}

				throw error;
			});

		if (!app) {
			logger.info("Creating Fly App", { app_name: serviceDetails.id });
			app = await fly.post("/apps", {
				app_name: serviceDetails.id,
				org_slug: ORG_SLUG,
			});
		} else {
			logger.log("Fly App", { flyApp: app });
		}

		const serviceConfig = JSON.parse(serviceDetails.configuration ?? "{}");

		const machines = await fly.get<Machine[]>(
			`/apps/${serviceDetails.id}/machines`,
		);
		logger.log("Machines", { machines });

		if (!machines?.length) {
			const newMachine = await fly.post<Machine>(
				`/apps/${serviceDetails.id}/machines`,
				{
					region: "iad",
					config: {
						image: `${serviceConfig.image}:${serviceConfig.tag}`,
					},
				},
			);
			logger.log("Created Fly Machine", { machine: newMachine });
		}

		return {
			message: "Service deployed successfully",
		};
	},
});
