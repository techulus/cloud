"use client";

import { Avatar } from "@/components/ui/avatar";
import {
	Dropdown,
	DropdownButton,
	DropdownDivider,
	DropdownItem,
	DropdownLabel,
	DropdownMenu,
} from "@/components/ui/dropdown";
import {
	Navbar,
	NavbarDivider,
	NavbarItem,
	NavbarLabel,
	NavbarSection,
	NavbarSpacer,
} from "@/components/ui/navbar";
import { signOut } from "@/lib/auth-client";
import {
	ArrowRightStartOnRectangleIcon,
	ChevronDownIcon,
	Cog8ToothIcon,
	LightBulbIcon,
	ShieldCheckIcon,
	UserIcon,
} from "@heroicons/react/16/solid";
import TeamsNav from "./teams-nav";
import { useRouter } from "next/navigation";
import type { User } from "better-auth";
import type { Organization } from "@/lib/user";

export function MainNav({
	navItems,
	user,
	organizations,
	activeOrganization,
}: {
	navItems: { label: string; url: string }[];
	user: User;
	organizations: Organization[];
	activeOrganization: Organization;
}) {
	const router = useRouter();

	return (
		<Navbar>
			<Dropdown>
				<DropdownButton as={NavbarItem} className="max-lg:hidden">
					<Avatar src={activeOrganization.logo ?? "/logo.png"} />
					<NavbarLabel>{activeOrganization.name}</NavbarLabel>
					<ChevronDownIcon />
				</DropdownButton>
				<TeamsNav organizations={organizations} />
			</Dropdown>
			<NavbarDivider className="max-lg:hidden" />
			<NavbarSection className="max-lg:hidden">
				{navItems.map(({ label, url }) => (
					<NavbarItem key={label} href={url}>
						{label}
					</NavbarItem>
				))}
			</NavbarSection>
			<NavbarSpacer />
			<NavbarSection>
				<Dropdown>
					<DropdownButton as={NavbarItem}>
						<Avatar src={user.image ?? "/logo.png"} square />
					</DropdownButton>
					<DropdownMenu className="min-w-64" anchor="bottom end">
						<DropdownItem href="/my-profile">
							<UserIcon />
							<DropdownLabel>My profile</DropdownLabel>
						</DropdownItem>
						<DropdownItem href="/settings">
							<Cog8ToothIcon />
							<DropdownLabel>Settings</DropdownLabel>
						</DropdownItem>
						<DropdownDivider />
						<DropdownItem href="/privacy-policy">
							<ShieldCheckIcon />
							<DropdownLabel>Privacy policy</DropdownLabel>
						</DropdownItem>
						<DropdownItem href="/share-feedback">
							<LightBulbIcon />
							<DropdownLabel>Share feedback</DropdownLabel>
						</DropdownItem>
						<DropdownDivider />
						<DropdownItem
							onClick={async () => {
								await signOut();
								router.replace("/");
							}}
						>
							<ArrowRightStartOnRectangleIcon />
							<DropdownLabel>Sign out</DropdownLabel>
						</DropdownItem>
					</DropdownMenu>
				</Dropdown>
			</NavbarSection>
		</Navbar>
	);
}
