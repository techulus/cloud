import { ControlPlaneUpgradeOverlay } from "@/components/core/upgrade-overlay";
import { getSetting } from "@/db/queries";
import type { ControlPlaneUpgradeState } from "@/lib/control-plane-updates";
import { SETTING_KEYS } from "@/lib/settings-keys";
import { DashboardLayoutClient } from "./layout-client";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const upgradeState = await getSetting<ControlPlaneUpgradeState>(
		SETTING_KEYS.CONTROL_PLANE_UPGRADE_STATE,
	);

	return (
		<>
			<ControlPlaneUpgradeOverlay initialState={upgradeState} />
			<DashboardLayoutClient>{children}</DashboardLayoutClient>
		</>
	);
}
