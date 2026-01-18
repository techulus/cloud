import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ZodError } from "zod";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function getZodErrorMessage(
	error: ZodError,
	fallback = "Validation failed",
): string {
	return error.issues[0]?.message || fallback;
}

export function formatZodErrors(error: ZodError): string {
	return error.issues
		.map((e) => `${e.path.join(".")}: ${e.message}`)
		.join("; ");
}

export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
