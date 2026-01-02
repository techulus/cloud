export const fetcher = <T = unknown>(url: string): Promise<T> =>
	fetch(url).then((res) => res.json());
