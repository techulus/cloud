import { NextResponse } from "next/server";
import { getAllRoutes, buildCaddyRoute } from "@/lib/caddy";

export async function GET() {
  try {
    const routes = await getAllRoutes();

    const caddyRoutes = routes.map((route) => ({
      ...route,
      caddyConfig: buildCaddyRoute(route),
    }));

    return NextResponse.json({ routes: caddyRoutes });
  } catch (error) {
    console.error("Failed to get Caddy config:", error);
    return NextResponse.json(
      { error: "Failed to get Caddy config" },
      { status: 500 }
    );
  }
}
