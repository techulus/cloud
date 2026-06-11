import { eventType, staticSchema } from "inngest";

export type { BackupEvents } from "./backup";
export type { BuildEvents } from "./build";
export type { MigrationEvents } from "./migration";
export type { RestoreEvents } from "./restore";
export type { RolloutEvents } from "./rollout";
export type { ServiceDeletionEvents } from "./service-deletion";

import type { BackupEvents } from "./backup";
import type { BuildEvents } from "./build";
import type { MigrationEvents } from "./migration";
import type { RestoreEvents } from "./restore";
import type { RolloutEvents } from "./rollout";
import type { ServiceDeletionEvents } from "./service-deletion";

export type Events = RolloutEvents &
	MigrationEvents &
	BackupEvents &
	RestoreEvents &
	BuildEvents &
	ServiceDeletionEvents;

type EventName = keyof Events & string;
type EventData<TName extends EventName> = Events[TName]["data"];

const defineEvent = <TName extends EventName>(name: TName) =>
	eventType(name, { schema: staticSchema<EventData<TName>>() });

export const inngestEvents = {
	rolloutCreated: defineEvent("rollout/created"),
	rolloutCancelled: defineEvent("rollout/cancelled"),
	deploymentHealthy: defineEvent("deployment/healthy"),
	deploymentFailed: defineEvent("deployment/failed"),
	serverDnsSynced: defineEvent("server/dns-synced"),

	migrationStarted: defineEvent("migration/started"),
	migrationCancelled: defineEvent("migration/cancelled"),
	migrationBackupCompleted: defineEvent("migration/backup-completed"),
	migrationBackupFailed: defineEvent("migration/backup-failed"),
	migrationRestoreCompleted: defineEvent("migration/restore-completed"),
	migrationRestoreFailed: defineEvent("migration/restore-failed"),
	migrationDeploymentHealthy: defineEvent("migration/deployment-healthy"),

	backupStarted: defineEvent("backup/started"),
	backupCompleted: defineEvent("backup/completed"),
	backupFailed: defineEvent("backup/failed"),

	restoreTrigger: defineEvent("restore/trigger"),
	restoreStarted: defineEvent("restore/started"),
	restoreCompleted: defineEvent("restore/completed"),
	restoreFailed: defineEvent("restore/failed"),

	serviceDeletionStarted: defineEvent("service-deletion/started"),
	serviceRestoreStarted: defineEvent("service-restore/started"),

	buildTrigger: defineEvent("build/trigger"),
	buildStarted: defineEvent("build/started"),
	buildCancelled: defineEvent("build/cancelled"),
	buildCompleted: defineEvent("build/completed"),
	manifestCompleted: defineEvent("manifest/completed"),
	manifestFailed: defineEvent("manifest/failed"),
};
