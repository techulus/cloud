import { resolveGarConfiguration } from "@/lib/registry-reference";

export async function GET() {
	try {
		resolveGarConfiguration();
	} catch {
		return Response.json(
			{ status: "error", error: "GAR configuration is invalid" },
			{ status: 503 },
		);
	}
	return Response.json({ status: "ok" });
}
