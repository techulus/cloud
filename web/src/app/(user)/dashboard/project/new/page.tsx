"use client";

import { Heading } from "@/components/ui/heading";
import { useState } from "react";
import { Label } from "@/components/ui/fieldset";
import { Field } from "@/components/ui/fieldset";
import { FieldGroup, Legend } from "@/components/ui/fieldset";
import { Fieldset } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";

import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { createProject } from "../../actions";
import { useRouter } from "next/navigation";

export default function CreateProject() {
	const [name, setName] = useState("");
	const router = useRouter();

	return (
		<div className="min-h-[80vh] flex items-center justify-center">
			<div className="max-w-md w-full text-center">
				<Heading className="text-3xl md:text-4xl mb-8 font-bold">
					Create Project
				</Heading>

				<form
					action={async () => {
						toast.promise(
							createProject({ name }).then(() => {
								router.push("/dashboard");
							}),
							{
								loading: "Creating project...",
								success: "Project created",
								error: "Failed to create project",
							},
						);
					}}
				>
					<Fieldset>
						<Legend>A project is a group of services</Legend>
						<Text>
							You can deploy containers, volumes, and more as part of a project.
						</Text>
						<FieldGroup>
							<Field>
								<Label>Project name</Label>
								<Input
									name="name"
									type="text"
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
						</FieldGroup>
					</Fieldset>
					<Button className="mt-6" type="submit">
						Create
					</Button>
				</form>
			</div>
		</div>
	);
}
