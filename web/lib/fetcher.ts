export const fetcher = <T = unknown>(url: string): Promise<T> =>
	fetch(url, { cache: "no-store" }).then((res) => res.json());
