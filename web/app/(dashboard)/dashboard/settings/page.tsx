import { listMembers } from "@/actions/members";
import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { GlobalSettings } from "@/components/settings/global-settings";
import { getGlobalSettings, listServers } from "@/db/queries";
import { requireAuth } from "@/lib/auth";
import { getUserRole } from "@/lib/members";

async function getMembersData() {
	try {
		const session = await requireAuth();
		if (!session) {
			return null;
		}
		const role = await getUserRole(session.user.id);
		if (role !== "admin") {
			return null;
		}

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
	} catch {
		return null;
	}
}

export default async function SettingsPage() {
	const [servers, settings, membersData] = await Promise.all([
		listServers(),
		getGlobalSettings(),
		getMembersData(),
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
