"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { createService, validateDockerImage } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export function CreateServiceDialog({
	projectId,
	onSuccess,
}: {
	projectId: string;
	onSuccess?: () => void;
}) {
	const { mutate } = useSWRConfig();
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [image, setImage] = useState("");
	const [stateful, setStateful] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !image.trim()) return;

		setIsLoading(true);
		setError(null);

		try {
			const validation = await validateDockerImage(image.trim());
			if (!validation.valid) {
				setError(validation.error || "Invalid image");
				setIsLoading(false);
				return;
			}

			await createService(projectId, name.trim(), image.trim(), [], stateful);
			setIsOpen(false);
			setName("");
			setImage("");
			setStateful(false);
			setError(null);
			await mutate(`/api/projects/${projectId}/services`);
			onSuccess?.();
		} catch (err) {
			console.error("Failed to create service:", err);
			setError("Failed to create service");
		} finally {
			setIsLoading(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setName("");
			setImage("");
			setStateful(false);
			setError(null);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger render={<Button />}>Add Service</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>New Service</DialogTitle>
				</DialogHeader>
				<Tabs defaultValue="docker">
					<TabsList>
						<TabsTrigger value="docker">Docker Image</TabsTrigger>
						<TabsTrigger value="github">GitHub Repo</TabsTrigger>
					</TabsList>
					<TabsContent value="docker">
						<form onSubmit={handleSubmit} className="space-y-4 pt-4">
							<div className="space-y-2">
								<Label htmlFor="service-name">Service Name</Label>
								<Input
									id="service-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="my-service"
									autoFocus
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="service-image">Docker Image</Label>
								<Input
									id="service-image"
									value={image}
									onChange={(e) => {
										setImage(e.target.value);
										setError(null);
									}}
									placeholder="nginx:latest"
								/>
								{error && <p className="text-sm text-red-500">{error}</p>}
								<p className="text-xs text-muted-foreground">
									Supported: Docker Hub, GitHub Container Registry (ghcr.io), or any public registry
								</p>
							</div>
							<div className="flex items-center justify-between rounded-lg border p-3">
								<div className="space-y-0.5">
									<Label htmlFor="stateful-toggle">Stateful Service</Label>
									<p className="text-xs text-muted-foreground">
										Enable to add persistent volumes. Limited to 1 replica and locked to a single server.
									</p>
								</div>
								<Switch
									id="stateful-toggle"
									checked={stateful}
									onCheckedChange={setStateful}
								/>
							</div>
							<div className="flex justify-end gap-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setIsOpen(false)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									disabled={isLoading || !name.trim() || !image.trim()}
								>
									{isLoading ? "Creating..." : "Create"}
								</Button>
							</div>
						</form>
					</TabsContent>
					<TabsContent value="github">
						<div className="py-8 text-center text-muted-foreground">
							Planned
						</div>
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
