import { AddSecret } from "@/components/services/add-secret";
import { DescriptionTerm } from "@/components/ui/description-list";
import { DescriptionDetails } from "@/components/ui/description-list";
import { DescriptionList } from "@/components/ui/description-list";

export default async function ServiceSecrets({
	params,
}: { params: Promise<{ projectId: string; serviceId: string }> }) {
	const { serviceId } = await params;

	return (
		<>
			<DescriptionList>
				<DescriptionTerm>ENV</DescriptionTerm>
				<DescriptionDetails>Production</DescriptionDetails>
			</DescriptionList>

			<AddSecret serviceId={serviceId} />
		</>
	);
}
