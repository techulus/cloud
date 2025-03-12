import { Avatar } from "@/components/ui/avatar";

import {
	Navbar,
	NavbarItem,
	NavbarLabel,
	NavbarSection,
	NavbarSpacer,
} from "@/components/ui/navbar";
import { StackedLayout } from "@/components/ui/stacked-layout";
import { getUser } from "@/lib/user";
import Link from "next/link";

export default async function OnboardingLayout({
	children,
}: { children: React.ReactNode }) {
	const user = await getUser();

	return (
		<StackedLayout
			navbar={
				<Navbar>
					<NavbarItem>
						<Link href="/" className="flex items-center gap-2">
							<Avatar src="/logo.png" className="w-6 h-6" />
							<NavbarLabel>
								techulus
								<span className="dark:text-rose-500 text-rose-600 font-bold">
									cloud
								</span>
							</NavbarLabel>
						</Link>
					</NavbarItem>
					<NavbarSpacer />
					<NavbarSection>
						<NavbarItem>
							<Avatar src={user.image ?? "/logo.png"} square />
						</NavbarItem>
					</NavbarSection>
				</Navbar>
			}
			sidebar={null}
		>
			{children}
		</StackedLayout>
	);
}
