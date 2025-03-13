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
import { useRouter } from "next/navigation";
import { createServer } from "../../dashboard/actions";

export default function CreateServer() {
	const [name, setName] = useState("");

	const router = useRouter();

	return (
		<div className="min-h-[70vh] flex items-center justify-center">
			<div className="max-w-md w-full text-center">
				<Heading className="text-3xl md:text-4xl mb-8 font-bold">
					Bring your own server
				</Heading>

				<form
					action={async () => {
						toast.promise(
							createServer({ name }).then(() => {
								router.push("/servers");
							}),
							{
								loading: "Creating server...",
								success: "Server created",
								error: "Failed to create server",
							},
						);
					}}
				>
					<Fieldset>
						<Legend>Add your server</Legend>
						<Text>
							Your projects and services will be deployed to available servers.
						</Text>
						<FieldGroup>
							<Field>
								<Label>Server name</Label>
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
