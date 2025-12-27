"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { createService } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
	const router = useRouter();
	const { mutate } = useSWRConfig();
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [image, setImage] = useState("");
	const [isLoading, setIsLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !image.trim()) return;

		setIsLoading(true);
		try {
			await createService(projectId, name.trim(), image.trim(), []);
			setIsOpen(false);
			setName("");
			setImage("");
			mutate(`/api/projects/${projectId}/services`);
			onSuccess?.();
			router.refresh();
		} catch (error) {
			console.error("Failed to create service:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (!open) {
			setName("");
			setImage("");
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
									onChange={(e) => setImage(e.target.value)}
									placeholder="nginx:latest"
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
