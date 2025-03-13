"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { DockIcon as Docker, GitBranchIcon } from "lucide-react";
import {
	Label,
	Field,
	FieldGroup,
	Fieldset,
	Legend,
} from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Heading } from "@/components/ui/heading";
import { createService } from "../../../actions";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";

const deploymentFormSchema = z.object({
	source: z.enum(["docker", "github"]),
	dockerImage: z.string().optional(),
	dockerTag: z.string().optional(),
	githubRepo: z.string().optional(),
	githubBranch: z.string().optional(),
	serviceName: z.string().min(3, {
		message: "Service name must be at least 3 characters.",
	}),
});

type DeploymentFormValues = z.infer<typeof deploymentFormSchema>;

const defaultValues: Partial<DeploymentFormValues> = {
	source: "docker",
	dockerTag: "latest",
	githubBranch: "main",
};

export default function CreateService() {
	const router = useRouter();
	const { projectId } = useParams();
	const [isSubmitting, setIsSubmitting] = useState(false);
	const {
		register,
		handleSubmit,
		watch,
		formState: { errors },
	} = useForm<DeploymentFormValues>({
		resolver: zodResolver(deploymentFormSchema),
		defaultValues,
	});

	const sourceType = watch("source");

	async function onSubmit(data: DeploymentFormValues) {
		setIsSubmitting(true);

		toast.promise(
			createService({
				type: sourceType,
				name: data.serviceName,
				image: data.dockerImage ?? "",
				tag: data.dockerTag ?? "",
				projectId: projectId as string,
			})
				.then(() => {
					router.push(`/dashboard/project/${projectId}`);
				})
				.finally(() => {
					setIsSubmitting(false);
				}),
			{
				loading: "Creating service...",
				success: "Service created successfully!",
				error: "Failed to create service.",
			},
		);
	}

	return (
		<>
			<div className="flex w-full flex-wrap items-end justify-between gap-4 border-b border-zinc-950/10 pb-6 dark:border-white/10">
				<Heading>New Service</Heading>
				<Text className="text-zinc-600 dark:text-zinc-400">
					Configure your service deployment settings.
				</Text>
			</div>
			<div className="w-full max-w-3xl mx-auto mt-8">
				<form onSubmit={handleSubmit(onSubmit)} className="space-y-8">
					<Fieldset>
						<FieldGroup>
							<Field>
								<Label htmlFor="serviceName">Service Name</Label>
								<Input
									id="serviceName"
									type="text"
									placeholder="my-awesome-service"
									invalid={!!errors.serviceName}
									{...register("serviceName")}
								/>
								{errors.serviceName && (
									<Text className="text-sm text-red-500">
										{errors.serviceName.message}
									</Text>
								)}
								<Text className="text-sm text-zinc-600 dark:text-zinc-400">
									This will be used as the identifier for your service.
								</Text>
							</Field>
						</FieldGroup>
					</Fieldset>

					<Fieldset>
						<Legend>Deployment Source</Legend>
						<FieldGroup>
							<Field className="flex space-x-6">
								<div className="flex items-center">
									<input
										id="docker"
										type="radio"
										value="docker"
										className="h-4 w-4"
										{...register("source")}
									/>
									<label htmlFor="docker" className="ml-2 flex items-center">
										<Docker className="w-4 h-4 mr-2" />
										Docker Image
									</label>
								</div>
								<div className="flex items-center">
									<input
										id="github"
										type="radio"
										value="github"
										className="h-4 w-4"
										{...register("source")}
									/>
									<label htmlFor="github" className="ml-2 flex items-center">
										<GitBranchIcon className="w-4 h-4 mr-2" />
										Public GitHub Repository
									</label>
								</div>
							</Field>
						</FieldGroup>
					</Fieldset>

					{sourceType === "docker" && (
						<Fieldset>
							<Legend>Docker Configuration</Legend>
							<FieldGroup>
								<Field>
									<Label htmlFor="dockerImage">Docker Image</Label>
									<Input
										id="dockerImage"
										type="text"
										placeholder="nginx"
										invalid={!!errors.dockerImage}
										{...register("dockerImage")}
									/>
									{errors.dockerImage && (
										<Text className="text-sm text-red-500">
											{errors.dockerImage.message}
										</Text>
									)}
									<Text className="text-sm text-zinc-600 dark:text-zinc-400">
										Enter the Docker image name (e.g., nginx, redis, postgres).
									</Text>
								</Field>

								<Field>
									<Label htmlFor="dockerTag">Image Tag</Label>
									<Input
										id="dockerTag"
										type="text"
										placeholder="latest"
										invalid={!!errors.dockerTag}
										{...register("dockerTag")}
									/>
									{errors.dockerTag && (
										<Text className="text-sm text-red-500">
											{errors.dockerTag.message}
										</Text>
									)}
									<Text className="text-sm text-zinc-600 dark:text-zinc-400">
										Specify the image tag (e.g., latest, 1.0.0, alpine).
									</Text>
								</Field>
							</FieldGroup>
						</Fieldset>
					)}

					{sourceType === "github" && (
						<Fieldset>
							<Legend>GitHub Configuration</Legend>
							<FieldGroup>
								<Field>
									<Label htmlFor="githubRepo">GitHub Repository</Label>
									<Input
										id="githubRepo"
										type="text"
										placeholder="username/repository"
										invalid={!!errors.githubRepo}
										{...register("githubRepo")}
									/>
									{errors.githubRepo && (
										<Text className="text-sm text-red-500">
											{errors.githubRepo.message}
										</Text>
									)}
									<Text className="text-sm text-zinc-600 dark:text-zinc-400">
										Enter the GitHub repository in the format
										username/repository.
									</Text>
								</Field>

								<Field>
									<Label htmlFor="githubBranch">Branch</Label>
									<Input
										id="githubBranch"
										type="text"
										placeholder="main"
										invalid={!!errors.githubBranch}
										{...register("githubBranch")}
									/>
									{errors.githubBranch && (
										<Text className="text-sm text-red-500">
											{errors.githubBranch.message}
										</Text>
									)}
									<Text className="text-sm text-zinc-600 dark:text-zinc-400">
										Specify the branch to deploy (e.g., main, develop).
									</Text>
								</Field>
							</FieldGroup>
						</Fieldset>
					)}

					<Button type="submit" disabled={isSubmitting} className="w-full">
						{isSubmitting ? "Submitting..." : "Create Service"}
					</Button>
				</form>
			</div>
		</>
	);
}
