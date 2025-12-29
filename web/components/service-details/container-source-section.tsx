"use client";

import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Box } from "lucide-react";
import type { Service } from "./types";

function parseImageInfo(image: string): {
	registry: string;
	repository: string;
	tag: string;
} {
	let registry = "docker.io";
	let repository = image;
	let tag = "latest";

	if (repository.includes(":")) {
		const parts = repository.split(":");
		repository = parts[0];
		tag = parts[1] || "latest";
	}

	if (repository.includes("/")) {
		const slashCount = (repository.match(/\//g) || []).length;
		if (slashCount >= 2 || repository.split("/")[0].includes(".")) {
			const firstSlash = repository.indexOf("/");
			registry = repository.substring(0, firstSlash);
			repository = repository.substring(firstSlash + 1);
		}
	}

	return { registry, repository, tag };
}

export const ContainerSourceSection = memo(function ContainerSourceSection({
	service,
}: {
	service: Service;
}) {
	const { registry, repository, tag } = parseImageInfo(service.image);

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="text-base flex items-center gap-2">
					<Box className="h-4 w-4" />
					Container Source
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="grid gap-4 sm:grid-cols-3">
					<div className="space-y-1">
						<p className="text-xs font-medium text-muted-foreground">
							Registry
						</p>
						<p className="text-sm font-mono">{registry}</p>
					</div>
					<div className="space-y-1">
						<p className="text-xs font-medium text-muted-foreground">
							Repository
						</p>
						<p className="text-sm font-mono">{repository}</p>
					</div>
					<div className="space-y-1">
						<p className="text-xs font-medium text-muted-foreground">Tag</p>
						<p className="text-sm font-mono">{tag}</p>
					</div>
				</div>
			</CardContent>
		</Card>
	);
});
