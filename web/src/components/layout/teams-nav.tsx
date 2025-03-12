import type { Organization } from "@/lib/user";
import { Avatar } from "../ui/avatar";
import {
	DropdownDivider,
	DropdownItem,
	DropdownLabel,
	DropdownMenu,
} from "../ui/dropdown";
import { PlusIcon } from "@heroicons/react/16/solid";

export default function TeamsNav({
	organizations,
}: {
	organizations: Organization[];
}) {
	return (
		<DropdownMenu className="min-w-80 lg:min-w-64" anchor="bottom start">
			{(organizations ?? []).map((organization) => (
				<DropdownItem key={organization.id} href={`/teams/${organization.id}`}>
					<Avatar slot="icon" src={organization.logo} />
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
