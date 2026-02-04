export type { RolloutEvents } from "./rollout";
export type { MigrationEvents } from "./migration";
export type { BackupEvents } from "./backup";
export type { RestoreEvents } from "./restore";
export type { BuildEvents } from "./build";
export type { AgentEvents } from "./agent";

import type { RolloutEvents } from "./rollout";
import type { MigrationEvents } from "./migration";
import type { BackupEvents } from "./backup";
import type { RestoreEvents } from "./restore";
import type { BuildEvents } from "./build";
import type { AgentEvents } from "./agent";

export type Events = RolloutEvents &
	MigrationEvents &
	BackupEvents &
	RestoreEvents &
	BuildEvents &
	AgentEvents;
