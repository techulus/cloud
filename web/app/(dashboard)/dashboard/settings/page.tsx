import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { GlobalSettings } from "@/components/global-settings";
import { listServers, getGlobalSettings } from "@/db/queries";

type Props = {
	searchParams: Promise<{ tab?: string }>;
};

export default async function SettingsPage({ searchParams }: Props) {
	const [servers, settings, params] = await Promise.all([
		listServers(),
		getGlobalSettings(),
		searchParams,
	]);

	const initialTab = params.tab || "build";

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
					initialSettings={settings}
					initialTab={initialTab}
				/>
			</div>
		</>
	);
}
