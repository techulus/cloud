import { notFound } from "next/navigation";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { ServerTabs } from "@/components/server/server-tabs";
import { getServerDetails } from "@/db/queries";

export default async function ServerLayout({
	params,
	children,
}: {
	params: Promise<{ id: string }>;
	children: React.ReactNode;
}) {
	const { id } = await params;
	const server = await getServerDetails(id);

	if (!server) {
		notFound();
	}

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: server.name, href: `/dashboard/servers/${id}` },
				]}
			/>
			<ServerTabs serverId={id} />
			{children}
		</>
	);
}
