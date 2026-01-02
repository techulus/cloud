"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { deleteService } from "@/actions/projects";
import { useService } from "@/components/service-layout-client";
import { SourceSection } from "@/components/service-details/source-section";
import { ReplicasSection } from "@/components/service-details/replicas-section";
import { VolumesSection } from "@/components/service-details/volumes-section";
import { SecretsSection } from "@/components/service-details/secrets-section";
import { PortsSection } from "@/components/service-details/ports-section";
import { HealthCheckSection } from "@/components/service-details/health-check-section";
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
import {
	Item,
	ItemContent,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { Trash2 } from "lucide-react";

export default function ConfigurationPage() {
	const router = useRouter();
	const { mutate: globalMutate } = useSWRConfig();
	const { service, projectSlug, onUpdate } = useService();
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await deleteService(service.id);
			await globalMutate(`/api/projects/${service.projectId}/services`);
			router.push(`/dashboard/projects/${projectSlug}`);
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="space-y-6">
			<SourceSection service={service} onUpdate={onUpdate} />

			<ReplicasSection service={service} onUpdate={onUpdate} />

			<VolumesSection service={service} onUpdate={onUpdate} />

			<SecretsSection service={service} onUpdate={onUpdate} />

			<PortsSection service={service} onUpdate={onUpdate} />

			<HealthCheckSection service={service} onUpdate={onUpdate} />

			<div className="space-y-3">
				<h2 className="text-xl font-semibold text-destructive">
					Danger Zone
				</h2>
				<div className="rounded-lg border border-destructive/50">
					<Item className="border-0">
						<ItemMedia variant="icon">
							<Trash2 className="size-5 text-destructive" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle>Delete this service</ItemTitle>
							<p className="text-sm text-muted-foreground">
								Once deleted, this service and all its deployments will
								be permanently removed.
							</p>
						</ItemContent>
						<AlertDialog>
							<AlertDialogTrigger
								render={<Button variant="destructive" />}
							>
								Delete Service
							</AlertDialogTrigger>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										Delete {service.name}?
									</AlertDialogTitle>
									<AlertDialogDescription>
										This action cannot be undone. This will permanently
										delete the service and all its deployments.
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
