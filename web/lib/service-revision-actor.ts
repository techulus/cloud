import { z } from "zod";

export type ServiceRevisionActor =
	| { type: "user"; userId: string; name: string }
	| { type: "github"; githubUserId: number; login: string }
	| { type: "system" };

export type DisplayServiceRevisionActor =
	| { type: "user"; name: string }
	| { type: "github"; login: string }
	| { type: "system" };

const actorSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("user"),
		userId: z.string(),
		name: z.string(),
	}),
	z.strictObject({
		type: z.literal("github"),
		githubUserId: z.number().int(),
		login: z.string(),
	}),
	z.strictObject({ type: z.literal("system") }),
]);

export function sanitizeServiceRevisionActor(
	value: unknown,
): DisplayServiceRevisionActor | null {
	const result = actorSchema.safeParse(value);
	if (!result.success) return null;
	const actor = result.data;
	if (actor.type === "user") return { type: "user", name: actor.name };
	if (actor.type === "github") return { type: "github", login: actor.login };
	return { type: "system" };
}
