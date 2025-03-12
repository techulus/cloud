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
import { ChevronDownIcon } from "@heroicons/react/16/solid";
import { Toaster } from "sonner";

const navItems = [
	{ label: "Dashboard", url: "/dashboard" },
	{ label: "Settings", url: "/settings" },
];

export default function DashboardLayout({
	children,
}: { children: React.ReactNode }) {
	return (
		<StackedLayout
			navbar={<MainNav navItems={navItems} />}
			sidebar={
				<Sidebar>
					<SidebarHeader>
						<Dropdown>
							<DropdownButton as={SidebarItem} className="lg:mb-2.5">
								<Avatar src="/logo.png" />
								<SidebarLabel>Techulus</SidebarLabel>
								<ChevronDownIcon />
							</DropdownButton>
							<TeamsNav />
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
			<Toaster position="bottom-center" />
		</StackedLayout>
	);
}
