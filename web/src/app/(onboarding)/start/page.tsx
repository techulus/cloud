"use client";

import { Heading } from "@/components/ui/heading";
import { useMemo, useState } from "react";
import { Label } from "@/components/ui/fieldset";
import { Field } from "@/components/ui/fieldset";
import { FieldGroup, Legend } from "@/components/ui/fieldset";
import { Fieldset } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function Start() {
	const [name, setName] = useState("");
	const slug = useMemo(() => name.toLowerCase().replace(/ /g, "-"), [name]);
	const router = useRouter();

	return (
		<div className="min-h-[80vh] flex items-center justify-center">
			<div className="max-w-md w-full text-center">
				<Heading className="text-3xl md:text-4xl mb-8 font-bold">
					Get Started
				</Heading>

				<form
					action={async () => {
						console.log("creating workspace", {
							name,
							slug,
						});
						toast.promise(
							authClient.organization
								.checkSlug({
									slug,
								})
								.then(({ data, error }) => {
									if (error) {
										throw new Error(error.message);
									}
									if (!data.status) {
										throw new Error("Slug is already taken");
									}
								})
								.then(() =>
									authClient.organization.create({
										name,
										slug,
									}),
								)
								.then(({ data, error }) => {
									console.log("created workspace", {
										data,
										error,
									});
									if (error) {
										throw new Error(error.message);
									}
									if (!data) {
										throw new Error("Failed to create workspace");
									}

									authClient.organization.setActive({
										organizationId: data.id,
									});
									router.push("/dashboard");
								}),
							{
								loading: "Creating workspace...",
								success: "Workspace created",
								error: "Failed to create workspace",
							},
						);
					}}
				>
					<Fieldset>
						<Legend>Create a workspace</Legend>
						<Text>A workspace is a group of projects and collaborators.</Text>
						<FieldGroup>
							<Field>
								<Label>Workspace name</Label>
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
