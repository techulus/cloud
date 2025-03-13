import { MainNav } from "@/components/layout/main-nav";
import TeamsNav from "@/components/layout/teams-nav";
import { Avatar } from "@/components/ui/avatar";
import { Dropdown, DropdownButton } from "@/components/ui/dropdown";
import {
	Sidebar,
	SidebarBody,
	SidebarHeader,
	SidebarItem,
	SidebarLabel,
	SidebarSection,
} from "@/components/ui/sidebar";
import { StackedLayout } from "@/components/ui/stacked-layout";
import { getOrganizations, getOwner, getUser } from "@/lib/user";
import { ChevronDownIcon } from "@heroicons/react/16/solid";
import { redirect } from "next/navigation";

const navItems = [
	{ label: "Dashboard", url: "/dashboard" },
	{ label: "Settings", url: "/settings" },
];

export default async function DashboardLayout({
	children,
}: { children: React.ReactNode }) {
	const user = await getUser();
	const organizations = await getOrganizations();

	if (organizations.length === 0) {
		redirect("/start");
	}

	const { orgId } = await getOwner();
	const activeOrganization = organizations.find((org) => org.id === orgId);

	if (!activeOrganization) {
		redirect("/start");
	}

	return (
		<StackedLayout
			navbar={
				<MainNav
					navItems={navItems}
					user={user}
					activeOrganization={activeOrganization}
					organizations={organizations}
				/>
			}
			sidebar={
				<Sidebar>
					<SidebarHeader>
						<Dropdown>
							<DropdownButton as={SidebarItem} className="lg:mb-2.5">
								<Avatar src={activeOrganization.logo ?? "/logo.png"} />
								<SidebarLabel>{activeOrganization?.name}</SidebarLabel>
								<ChevronDownIcon />
							</DropdownButton>
							<TeamsNav organizations={organizations} />
						</Dropdown>
					</SidebarHeader>
					<SidebarBody>
						<SidebarSection>
							{navItems.map(({ label, url }) => (
								<SidebarItem key={label} href={url}>
									{label}
								</SidebarItem>
							))}
						</SidebarSection>
					</SidebarBody>
				</Sidebar>
			}
		>
			{children}
		</StackedLayout>
	);
}
