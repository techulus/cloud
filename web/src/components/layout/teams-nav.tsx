"use client";

import type { Organization } from "@/lib/user";
import { Avatar } from "../ui/avatar";
import {
	DropdownDivider,
	DropdownItem,
	DropdownLabel,
	DropdownMenu,
} from "../ui/dropdown";
import { PlusIcon } from "@heroicons/react/16/solid";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export default function TeamsNav({
	organizations,
}: {
	organizations: Organization[];
}) {
	const router = useRouter();

	return (
		<DropdownMenu className="min-w-80 lg:min-w-64" anchor="bottom start">
			{organizations.map((organization) => (
				<DropdownItem
					key={organization.id}
					onClick={async () => {
						toast.promise(
							authClient.organization
								.setActive({
									organizationId: organization.id,
								})
								.then(() => {
									router.replace("/dashboard");
								}),
							{
								loading: "Switching workspace...",
								success: "Switched workspace",
								error: "Failed to switch workspace",
							},
						);
					}}
				>
					<Avatar slot="icon" src={organization.logo ?? "/logo.png"} />
					<DropdownLabel>{organization.name}</DropdownLabel>
				</DropdownItem>
			))}
			<DropdownDivider />
			<DropdownItem href="/start">
				<PlusIcon />
				<DropdownLabel>New workspace</DropdownLabel>
			</DropdownItem>
		</DropdownMenu>
	);
}
