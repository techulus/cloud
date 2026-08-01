import { parseImageReference } from "@/lib/registry-reference";

export function imageUsesMutableReference(image: string): boolean {
	if (image.includes("@")) return false;
	const lastSlash = image.lastIndexOf("/");
	const lastColon = image.lastIndexOf(":");
	return lastColon <= lastSlash || image.slice(lastColon + 1) === "latest";
}

export function imageIsUnqualified(image: string): boolean {
	return !image.split("@")[0]?.includes("/");
}

export function imageNeedsProductionPinning(image: string): boolean {
	return image !== "" && imageUsesMutableReference(image);
}

export async function validateDockerImageInternal(
	image: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		parseImageReference(image);
		return { valid: true };
	} catch (error) {
		return {
			valid: false,
			error:
				error instanceof Error
					? error.message
					: "Invalid image reference syntax",
		};
	}
}
