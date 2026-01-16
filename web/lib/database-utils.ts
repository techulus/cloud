export function detectDatabaseType(image: string): string | null {
	const imageLower = image.toLowerCase();
	if (imageLower.includes("postgres")) return "postgres";
	if (imageLower.includes("mysql")) return "mysql";
	if (imageLower.includes("mariadb")) return "mariadb";
	if (imageLower.includes("mongo")) return "mongodb";
	if (imageLower.includes("redis")) return "redis";
	return null;
}
