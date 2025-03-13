"use client";

import { Button } from "@/components/ui/button";
import { Field, Label } from "../ui/fieldset";
import { Input } from "../ui/input";
import { useState } from "react";
import { createSecret } from "@/app/(user)/dashboard/actions";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

export function AddSecret({ serviceId }: { serviceId: string }) {
	const router = useRouter();

	const [addSecret, setAddSecret] = useState(false);

	const [key, setKey] = useState("");
	const [value, setValue] = useState("");

	return (
		<div>
			{addSecret ? (
				<form
					action={async () => {
						toast.promise(
							createSecret({
								serviceId,
								key,
								value,
							}).then(() => {
								setAddSecret(false);
								setKey("");
								setValue("");

								router.refresh();
							}),
							{
								loading: "Creating secret...",
								success: "Secret created",
								error: "Failed to create secret",
							},
						);
					}}
				>
					<div className="grid grid-cols-2 gap-4 mb-4">
						<Field className="flex flex-col">
							<Label>Key</Label>
							<Input
								type="text"
								placeholder="DATABASE_URL"
								onChange={(e) => setKey(e.target.value)}
							/>
						</Field>
						<Field className="flex flex-col">
							<Label>Value</Label>
							<Input
								type="text"
								placeholder="postgres://..."
								onChange={(e) => setValue(e.target.value)}
							/>
						</Field>
					</div>

					<Button type="submit">Save</Button>
				</form>
			) : (
				<Button onClick={() => setAddSecret(!addSecret)}>
					{addSecret ? "Cancel" : "Add Secret"}
				</Button>
			)}
		</div>
	);
}
