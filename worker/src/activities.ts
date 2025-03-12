import { FlyClient } from "./lib/fly";

const ORG_SLUG = "arjun-komath";

export async function createApp(
	flyToken: string,
	payload: {
		app_name: string;
	},
): Promise<{ id: string; created_at: number }> {
	return { id: "p7vx1jy8x4z1k3z5", created_at: 1741764081000 };
	// try {
	// 	console.log("Creating app", {
	// 		payload,
	// 	});
	// 	const client = new FlyClient(flyToken);
	// 	const result = await client.post("/apps", {
	// 		...payload,
	// 		org_slug: ORG_SLUG,
	// 	});
	// 	console.log("Created app", result);
	// 	return result;
	// } catch (error) {
	// 	console.error("Error creating app", error);
	// 	throw error;
	// }
}
