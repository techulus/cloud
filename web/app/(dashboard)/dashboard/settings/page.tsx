import { listMembers } from "@/actions/members";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { GlobalSettings } from "@/components/settings/global-settings";
import { getGlobalSettings, listServers } from "@/db/queries";
import { requireAdminRole } from "@/lib/auth";
import { AdminNotConfiguredError } from "@/lib/members";
import { listRegistryMetadata } from "@/lib/registry-credentials";

async function getRegistryData() {
	try {
		if (!(await requireAdminRole())) return null;
		return await listRegistryMetadata();
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message === "Unauthorized" || error.message === "Forbidden")
		)
			return null;
		throw error;
	}
}

async function getMembersData() {
	try {
		const data = await listMembers();
		return {
			members: data.members.map((member) => ({
				...member,
				createdAt: member.createdAt.toISOString(),
			})),
			invitations: data.invitations.map((invitation) => ({
				...invitation,
				expiresAt: invitation.expiresAt.toISOString(),
				createdAt: invitation.createdAt.toISOString(),
			})),
		};
	} catch (error) {
		if (
			error instanceof AdminNotConfiguredError ||
			(error instanceof Error &&
				(error.message === "Unauthorized" || error.message === "Forbidden"))
		) {
			return null;
		}

		throw error;
	}
}

export default async function SettingsPage() {
	const [servers, settings, membersData, registries] = await Promise.all([
		listServers(),
		getGlobalSettings(),
		getMembersData(),
		getRegistryData(),
	]);

	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: "Settings", href: "/dashboard/settings" },
				]}
			/>
			<div className="container max-w-7xl mx-auto px-4 py-6 space-y-6">
				<div>
					<h1 className="text-2xl font-semibold">Settings</h1>
					<p className="text-muted-foreground">
						Configure global settings for your infrastructure
					</p>
				</div>

				<GlobalSettings
					servers={servers}
					membersData={membersData}
					initialSettings={settings}
					registries={registries}
					appVersion={
						process.env.TECHULUS_CLOUD_VERSION ??
						process.env.NEXT_PUBLIC_APP_VERSION ??
						null
					}
				/>
			</div>
		</>
	);
}
