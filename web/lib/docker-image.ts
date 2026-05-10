export function imageUsesMutableReference(image: string): boolean {
	if (image.includes("@")) return false;

	const lastSlash = image.lastIndexOf("/");
	const lastColon = image.lastIndexOf(":");
	if (lastColon <= lastSlash) return true;

	return image.slice(lastColon + 1) === "latest";
}

export function imageIsUnqualified(image: string): boolean {
	const imageWithoutDigest = image.split("@")[0];
	return !imageWithoutDigest.includes("/");
}

export function imageNeedsProductionPinning(image: string): boolean {
	return image !== "" && imageUsesMutableReference(image);
}
