import { afterEach, describe, expect, it, vi } from "vitest";
import { FetcherError, fetcher } from "@/lib/fetcher";

describe("fetcher", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns parsed JSON responses", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ healthy: true }), {
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(fetcher("/api/health")).resolves.toEqual({ healthy: true });
		expect(fetchMock).toHaveBeenCalledWith("/api/health", {
			cache: "no-store",
		});
	});

	it("throws a FetcherError with the API message for failed responses", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: "Service not found" }), {
					status: 404,
					statusText: "Not Found",
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		let thrown: unknown;
		try {
			await fetcher("/api/missing");
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(FetcherError);
		expect(thrown).toMatchObject({
			message: "Service not found",
			status: 404,
			info: { message: "Service not found" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
