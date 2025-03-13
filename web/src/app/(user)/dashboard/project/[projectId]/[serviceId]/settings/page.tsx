import { Heading } from "@/components/ui/heading";

export default async function ServiceDetails({
	params,
}: { params: Promise<{ projectId: string; serviceId: string }> }) {
	const { projectId, serviceId } = await params;
	console.log(projectId, serviceId);

	return (
		<>
			<Heading>Settings</Heading>
		</>
	);
}
