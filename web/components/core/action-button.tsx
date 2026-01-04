"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface ActionButtonProps {
	action: () => Promise<unknown>;
	label: string;
	loadingLabel: string;
	variant?:
		| "default"
		| "destructive"
		| "outline"
		| "secondary"
		| "ghost"
		| "link"
		| "warning";
	size?: "default" | "sm" | "lg" | "icon";
	onComplete?: () => void;
}

export function ActionButton({
	action,
	label,
	loadingLabel,
	variant = "default",
	size = "sm",
	onComplete,
}: ActionButtonProps) {
	const [isLoading, setIsLoading] = useState(false);

	const handleClick = async () => {
		setIsLoading(true);
		try {
			await action();
			onComplete?.();
		} catch (error) {
			console.error("Action failed:", error);
			// Handle all error types: Error instances, objects with message, strings, or unknown
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "string"
						? error
						: error &&
								typeof error === "object" &&
								"message" in error &&
								typeof error.message === "string"
							? error.message
							: "An error occurred";
			toast.error(errorMessage);
		} finally {
			setIsLoading(false);
		}
	};

	return (
		<Button
			onClick={handleClick}
			disabled={isLoading}
			variant={variant}
			size={size}
		>
			{isLoading ? loadingLabel : label}
		</Button>
	);
}
