import Link from "next/link";
import { Box, Layers } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Item,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from "@/components/ui/item";
import { getServerServices } from "@/db/queries";

export async function ServerServices({ serverId }: { serverId: string }) {
	const services = await getServerServices(serverId);

	if (services.length === 0) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Layers className="h-5 w-5" />
					Running Services
				</CardTitle>
				<CardDescription>
					{services.length} service{services.length !== 1 ? "s" : ""} deployed
					on this server
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ItemGroup className="grid gap-3 md:grid-cols-2">
					{services.map((service) => (
						<Item
							key={service.deploymentId}
							variant="outline"
							render={
								<Link
									href={`/dashboard/projects/${service.projectSlug}/${service.environmentName}?service=${service.serviceId}`}
								/>
							}
						>
							<ItemMedia variant="icon">
								<Box className="size-5 text-muted-foreground" />
							</ItemMedia>
							<ItemContent>
								<ItemTitle className="truncate">
									{service.serviceName}
								</ItemTitle>
								<ItemDescription className="truncate">
									{service.projectName} / {service.environmentName}
								</ItemDescription>
							</ItemContent>
						</Item>
					))}
				</ItemGroup>
			</CardContent>
		</Card>
	);
}
