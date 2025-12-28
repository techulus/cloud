"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSWRConfig } from "swr";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { createService, validateDockerImage } from "@/actions/projects";
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
	const [isValidating, setIsValidating] = useState(false);
	const [validationResult, setValidationResult] = useState<{
		valid: boolean;
		error?: string;
	} | null>(null);

	const handleImageBlur = async () => {
		if (!image.trim()) {
			setValidationResult(null);
			return;
		}
		setIsValidating(true);
		setValidationResult(null);
		const result = await validateDockerImage(image.trim());
		setValidationResult(result);
		setIsValidating(false);
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !image.trim()) return;

		if (!validationResult) {
			setIsValidating(true);
			const result = await validateDockerImage(image.trim());
			setValidationResult(result);
			setIsValidating(false);
			if (!result.valid) return;
		} else if (!validationResult.valid) {
			return;
		}

		setIsLoading(true);
		try {
			await createService(projectId, name.trim(), image.trim(), []);
			setIsOpen(false);
			setName("");
			setImage("");
			setValidationResult(null);
			await mutate(`/api/projects/${projectId}/services`);
			onSuccess?.();
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
			setValidationResult(null);
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
								<div className="relative">
									<Input
										id="service-image"
										value={image}
										onChange={(e) => {
											setImage(e.target.value);
											setValidationResult(null);
										}}
										onBlur={handleImageBlur}
										placeholder="nginx:latest"
										className={
											validationResult && !validationResult.valid
												? "border-red-500 focus:border-red-500"
												: ""
										}
									/>
									{isValidating && (
										<div className="absolute right-3 top-1/2 -translate-y-1/2">
											<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
										</div>
									)}
									{!isValidating && validationResult?.valid && (
										<div className="absolute right-3 top-1/2 -translate-y-1/2">
											<CheckCircle2 className="h-4 w-4 text-green-500" />
										</div>
									)}
									{!isValidating && validationResult && !validationResult.valid && (
										<div className="absolute right-3 top-1/2 -translate-y-1/2">
											<AlertCircle className="h-4 w-4 text-red-500" />
										</div>
									)}
								</div>
								{validationResult && !validationResult.valid && (
									<p className="text-sm text-red-500">{validationResult.error}</p>
								)}
								<p className="text-xs text-muted-foreground">
									Supported: Docker Hub, GitHub Container Registry (ghcr.io), or any public registry
								</p>
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
									disabled={
										isLoading ||
										isValidating ||
										!name.trim() ||
										!image.trim() ||
										(validationResult !== null && !validationResult.valid)
									}
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
