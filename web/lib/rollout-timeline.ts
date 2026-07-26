import { rolloutStageTransitions } from "@/db/schema";
import type { DbTransaction } from "@/lib/agent-generation";

export type RolloutTimelineStage =
	| "created"
	| "turn_acquired"
	| "deployments_committed"
	| "expected_state_fetched"
	| "control_plane_ready"
	| "promotion_committed"
	| "routing_acknowledged"
	| "completed"
	| "failed";

/** Records the first observation of a one-way boundary; replays preserve it. */
export async function recordRolloutStageBoundary(
	tx: DbTransaction,
	input: {
		rolloutId: string;
		stage: RolloutTimelineStage;
		serverId?: string;
		generation?: number;
		at?: Date;
	},
) {
	const at = input.at ?? new Date();
	const scope = input.serverId
		? `${input.serverId}:${input.generation ?? ""}`
		: "";
	await tx
		.insert(rolloutStageTransitions)
		.values({
			rolloutId: input.rolloutId,
			stage: input.stage,
			scope,
			serverId: input.serverId,
			generation: input.generation,
			enteredAt: at,
		})
		.onConflictDoNothing();
}
