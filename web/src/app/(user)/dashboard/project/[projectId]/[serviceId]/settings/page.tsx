import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export default async function ServiceDetails({
	params,
}: { params: Promise<{ projectId: string; serviceId: string }> }) {
	const { projectId, serviceId } = await params;
	console.log(projectId, serviceId);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<Heading>Delete Service</Heading>
				<p className="text-sm text-zinc-600 dark:text-zinc-400 py-4">
					Are you sure you want to delete this service? This action cannot be
					undone.
				</p>
				<Button color="red">Delete</Button>
			</div>
		</div>
	);
}
