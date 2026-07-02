export class FetcherError extends Error {
	status: number;
	info: unknown;

	constructor(message: string, status: number, info: unknown) {
		super(message);
		this.name = "FetcherError";
		this.status = status;
		this.info = info;
	}
}

export const fetcher = async <T = unknown>(url: string): Promise<T> => {
	const response = await fetch(url, { cache: "no-store" });
	const contentType = response.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json")
		? await response.json().catch(() => undefined)
		: await response.text().catch(() => undefined);

	if (!response.ok) {
		const message =
			typeof body === "object" &&
			body !== null &&
			"message" in body &&
			typeof body.message === "string"
				? body.message
				: response.statusText || "Request failed";

		throw new FetcherError(message, response.status, body);
	}

	return body as T;
};
