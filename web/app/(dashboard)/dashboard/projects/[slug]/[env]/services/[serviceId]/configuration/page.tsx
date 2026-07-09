"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { deleteService } from "@/actions/projects";
import { DeleteConfirmationDialog } from "@/components/core/delete-confirmation-dialog";
import { LocalDate } from "@/components/core/local-date";
import { HealthCheckSection } from "@/components/service/details/health-check-section";
import { PortsSection } from "@/components/service/details/ports-section";
import { ReplicasSection } from "@/components/service/details/replicas-section";
import { ResourceLimitsSection } from "@/components/service/details/resource-limits-section";
import { ScheduleSection } from "@/components/service/details/schedule-section";
import { SecretsSection } from "@/components/service/details/secrets-section";
import { ServerlessSection } from "@/components/service/details/serverless-section";
import { SourceSection } from "@/components/service/details/source-section";
import { StartCommandSection } from "@/components/service/details/start-command-section";
import { TCPProxySection } from "@/components/service/details/tcp-proxy-section";
import { VolumesSection } from "@/components/service/details/volumes-section";
import { useService } from "@/components/service/service-layout-client";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import type { DeleteConfirmation } from "@/lib/two-factor";

const ACTIVE_DELETE_BACKUP_STATUSES = ["running", "healthy"] as const;

export default function ConfigurationPage() {
	const router = useRouter();
	const { mutate: globalMutate } = useSWRConfig();
	const { service, projectSlug, envName, proxyDomain, onUpdate } = useService();
	const hasActiveDeploymentForBackup = service.deployments.some(
		(deployment) =>
			ACTIVE_DELETE_BACKUP_STATUSES.includes(
				deployment.observedPhase as (typeof ACTIVE_DELETE_BACKUP_STATUSES)[number],
			) && !!deployment.containerId,
	);
	const hasVolumes = (service.volumes?.length ?? 0) > 0;
	const willReuseCompletedBackups =
		service.stateful && hasVolumes && !hasActiveDeploymentForBackup;
	const hasCompletedBackupForEveryVolume =
		service.deletionBackupFallback &&
		service.deletionBackupFallback.backedUpVolumeCount ===
			service.deletionBackupFallback.volumeCount;

	const handleConfigSave = useCallback(() => {
		onUpdate();
		toast.info("Changes saved. Deploy to apply them.");
	}, [onUpdate]);

	const handleDelete = async (confirmation?: DeleteConfirmation) => {
		await deleteService(service.id, confirmation);
		await globalMutate(`/api/projects/${service.projectId}/services`);
		toast.success(
			service.stateful ? "Delete workflow started" : "Service deleted",
		);
		router.push(`/dashboard/projects/${projectSlug}/${envName}`);
	};

	return (
		<div className="space-y-6">
			<SourceSection service={service} onUpdate={handleConfigSave} />

			<ReplicasSection service={service} onUpdate={handleConfigSave} />

			<VolumesSection service={service} onUpdate={handleConfigSave} />

			<SecretsSection service={service} onUpdate={handleConfigSave} />

			<PortsSection service={service} onUpdate={handleConfigSave} />

			<TCPProxySection
				service={service}
				proxyDomain={proxyDomain}
				onUpdate={handleConfigSave}
			/>

			<HealthCheckSection service={service} onUpdate={handleConfigSave} />

			<ResourceLimitsSection service={service} onUpdate={handleConfigSave} />

			<ServerlessSection service={service} onUpdate={handleConfigSave} />

			<StartCommandSection service={service} onUpdate={handleConfigSave} />

			<ScheduleSection service={service} onUpdate={handleConfigSave} />

			<div className="space-y-3">
				<h2 className="text-xl font-semibold text-destructive">Danger Zone</h2>
				<div className="rounded-lg border border-destructive/50">
					<Item className="border-0">
						<ItemMedia variant="icon">
							<Trash2 className="size-5 text-destructive" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Delete this service</ItemTitle>
							<p className="text-sm text-muted-foreground">
								{service.stateful
									? "Stateful services are backed up and retained for 7 days before permanent purge."
									: "Once deleted, this service and all its deployments will be permanently removed."}
							</p>
						</ItemContent>
						<DeleteConfirmationDialog
							resourceName={service.name}
							triggerLabel="Delete Service"
							description={
								service.stateful ? (
									<>
										This starts a backup-first delete workflow. The service will
										be restorable from Deleted services until its retention
										window expires.
										{willReuseCompletedBackups &&
											hasCompletedBackupForEveryVolume && (
												<>
													<br />
													<br />
													<span className="font-medium text-foreground">
														This service is not currently running.
													</span>{" "}
													Restore will use the latest completed backups for its
													volumes. The oldest selected backup is from{" "}
													<LocalDate
														value={
															service.deletionBackupFallback
																?.oldestLatestBackupAt
														}
														fallback="an unknown time"
													/>
													; changes after that backup will not be restored.
												</>
											)}
										{willReuseCompletedBackups &&
											!hasCompletedBackupForEveryVolume && (
												<>
													<br />
													<br />
													<span className="font-medium text-destructive">
														No completed backup is available for every volume.
													</span>{" "}
													Delete will fail unless the service is running so a
													fresh deletion backup can be created.
												</>
											)}
									</>
								) : (
									"This action cannot be undone. This will permanently delete the service and all its deployments."
								)
							}
							fallbackError="Failed to delete service"
							onDelete={handleDelete}
						/>
					</Item>
				</div>
			</div>
		</div>
	);
}
