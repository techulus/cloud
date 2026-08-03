import { SetBreadcrumbs } from "@/components/core/breadcrumb-data";
import { NotificationsList } from "@/components/dashboard/notifications-list";

export default function NotificationsPage() {
	return (
		<>
			<SetBreadcrumbs
				items={[
					{ label: "Dashboard", href: "/dashboard" },
					{ label: "Notifications", href: "/dashboard/notifications" },
				]}
			/>
			<div className="container max-w-7xl mx-auto px-4 py-6 space-y-6">
				<div>
					<h1 className="text-2xl font-semibold">Notifications</h1>
					<p className="text-muted-foreground">
						Operational alerts for your infrastructure
					</p>
				</div>
				<NotificationsList />
			</div>
		</>
	);
}
