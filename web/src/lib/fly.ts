type RequestOptions<T> = {
	method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
	payload?: T;
	headers?: Record<string, string>;
};

export class FlyClient {
	private baseUrl: string;
	private defaultHeaders: Record<string, string>;
	private apiToken: string;

	constructor() {
		this.baseUrl = "https://api.machines.dev/v1";
		if (!process.env.FLY_API_TOKEN) {
			throw new Error("FLY_API_TOKEN is not set");
		}
		this.apiToken = process.env.FLY_API_TOKEN;

		this.defaultHeaders = {
			Authorization: `Bearer ${this.apiToken}`,
			"Content-Type": "application/json",
		};
	}

	async request<T, P = unknown>(
		path: string,
		options: RequestOptions<P> = {},
	): Promise<T> {
		const { method = "GET", payload, headers = {} } = options;

		const requestOptions: RequestInit = {
			method,
			headers: {
				...this.defaultHeaders,
				...headers,
			},
		};

		if (payload) {
			requestOptions.body = JSON.stringify(payload);
		}

		const response = await fetch(`${this.baseUrl}${path}`, requestOptions);

		if (!response.ok) {
			const errorData = await response.json();
			throw {
				status: response.status,
				statusText: response.statusText,
				data: errorData,
			};
		}

		return response.json();
	}

	// Convenience methods
	async get<T>(path: string, headers?: Record<string, string>): Promise<T> {
		return this.request<T>(path, { headers });
	}

	async post<T, P = unknown>(
		path: string,
		payload: P,
		headers?: Record<string, string>,
	): Promise<T> {
		return this.request<T>(path, { method: "POST", payload, headers });
	}

	async put<T, P = unknown>(
		path: string,
		payload: P,
		headers?: Record<string, string>,
	): Promise<T> {
		return this.request<T>(path, { method: "PUT", payload, headers });
	}

	async delete<T>(path: string, headers?: Record<string, string>): Promise<T> {
		return this.request<T>(path, { method: "DELETE", headers });
	}
}
