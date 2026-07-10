import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalDate } from "@/components/core/local-date";

describe("LocalDate", () => {
	it("renders a hydration-stable hidden UTC value on the server", () => {
		const html = renderToStaticMarkup(
			<LocalDate value="2026-07-10T02:00:00Z" />,
		);

		expect(html).toContain('dateTime="2026-07-10T02:00:00.000Z"');
		expect(html).toContain('class="invisible"');
		expect(html).toContain("Jul 10, 2026, 02:00");
	});

	it("renders fallbacks immediately for missing values", () => {
		expect(
			renderToStaticMarkup(<LocalDate value={null} fallback="Never" />),
		).toBe("Never");
	});
});
