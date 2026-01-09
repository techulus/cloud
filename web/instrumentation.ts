export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const { startCronEngine } = await import("./lib/cron");
		startCronEngine();
	}
}
