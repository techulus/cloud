import { notFound } from "next/navigation";
import { getProjectBySlug, getEnvironmentByName } from "@/db/queries";
import { ImportComposeForm } from "./import-compose-form";

export default async function ImportComposePage({
	params,
}: {
	params: Promise<{ slug: string; env: string }>;
}) {
	const { slug, env } = await params;

	const project = await getProjectBySlug(slug);
	if (!project) {
		notFound();
	}

	const environment = await getEnvironmentByName(project.id, env);
	if (!environment) {
		notFound();
	}

	return (
		<ImportComposeForm
			projectId={project.id}
			environmentId={environment.id}
			slug={slug}
			env={env}
		/>
	);
}
