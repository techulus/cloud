"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import { deleteService } from "@/actions/projects";
import { useService } from "@/components/service/service-layout-client";
import { SourceSection } from "@/components/service/details/source-section";
import { ReplicasSection } from "@/components/service/details/replicas-section";
import { VolumesSection } from "@/components/service/details/volumes-section";
import { SecretsSection } from "@/components/service/details/secrets-section";
import { PortsSection } from "@/components/service/details/ports-section";
import { TCPProxySection } from "@/components/service/details/tcp-proxy-section";
import { HealthCheckSection } from "@/components/service/details/health-check-section";
import { ResourceLimitsSection } from "@/components/service/details/resource-limits-section";
import { StartCommandSection } from "@/components/service/details/start-command-section";
import { ScheduleSection } from "@/components/service/details/schedule-section";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Trash2 } from "lucide-react";

export default function ConfigurationPage() {
	const router = useRouter();
	const { mutate: globalMutate } = useSWRConfig();
	const { service, projectSlug, envName, proxyDomain, onUpdate } = useService();
	const [isDeleting, setIsDeleting] = useState(false);

	const handleConfigSave = useCallback(() => {
		onUpdate();
		toast.info("Changes saved. Deploy to apply them.");
	}, [onUpdate]);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await deleteService(service.id);
			await globalMutate(`/api/projects/${service.projectId}/services`);
			router.push(`/dashboard/projects/${projectSlug}/${envName}`);
		} finally {
			setIsDeleting(false);
		}
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
								Once deleted, this service and all its deployments will be
								permanently removed.
							</p>
						</ItemContent>
						<AlertDialog>
							<AlertDialogTrigger render={<Button variant="destructive" />}>
								Delete Service
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>Delete {service.name}?</AlertDialogTitle>
									<AlertDialogDescription>
										This action cannot be undone. This will permanently delete
										the service and all its deployments.
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>Cancel</AlertDialogCancel>
									<AlertDialogAction
										variant="destructive"
										onClick={handleDelete}
										disabled={isDeleting}
									>
										{isDeleting ? "Deleting..." : "Delete"}
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</Item>
				</div>
			</div>
		</div>
	);
}
