import { render } from "@react-email/render";
import { describe, expect, it } from "vitest";
import { Alert } from "@/lib/email/templates/alert";
import { MemberInvitation } from "@/lib/email/templates/member-invitation";

const longContent = "x".repeat(2_000);

const templates = {
	alert: Alert({
		bannerText: "BUILD FAILED",
		heading: "Build Failure Alert",
		description: "The build failed.",
		details: [{ label: "Error", value: longContent }],
	}),
	invitation: MemberInvitation({
		inviterName: longContent,
		role: "member",
		inviteUrl: `https://cloud.example.com/invite/${longContent}`,
	}),
};

describe("email templates", () => {
	it.each(Object.entries(templates))(
		"constrains and wraps long %s content",
		async (_, template) => {
			const html = await render(template);

			expect(html).toContain(longContent);
			expect(html).toContain('width="600"');
			expect(html).toContain("width:100%");
			expect(html).toContain("max-width:600px");
			expect(html).toContain("table-layout:fixed");
			expect(html).toContain("overflow-wrap:anywhere");
			expect(html).toContain("word-break:break-word");
			expect(html).toContain("word-wrap:break-word");
		},
	);
});
