import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { GlobalSettings } from "@/components/settings/global-settings";
import { listServers, getGlobalSettings } from "@/db/queries";

export default async function SettingsPage() {
	const [servers, settings] = await Promise.all([
		listServers(),
		getGlobalSettings(),
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

				<GlobalSettings servers={servers} initialSettings={settings} />
			</div>
		</>
	);
}
