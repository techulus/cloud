import { requireApiKeyRole } from "@/lib/api-auth";
export async function GET(request: Request) {
	const auth = await requireApiKeyRole(request, [
		"admin",
		"developer",
		"reader",
	]);
	if (!auth.ok) return auth.response;
	return Response.json({
		user: {
			id: auth.session.user.id,
			name: auth.session.user.name,
			email: auth.session.user.email,
			role: auth.session.user.role,
		},
		session: {
			id: auth.session.session.id,
			expiresAt: auth.session.session.expiresAt,
		},
	});
}
