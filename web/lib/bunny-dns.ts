import type { EdgeDnsConfig } from "@/lib/edge-dns";

const API = "https://api.bunny.net";
const MANAGED_COMMENT = "Managed by Techulus Cloud";

export type BunnyRecord = {
	Id: number;
	Type: number;
	Name: string | null;
	Value: string | null;
	Comment?: string | null;
};

export function deriveBunnyRecordName(hostname: string, zoneDomain: string) {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const zone = zoneDomain.toLowerCase().replace(/\.$/, "");
	if (host === zone) return "";
	if (!host.endsWith(`.${zone}`))
		throw new Error(`Edge hostname is not contained by DNS zone ${zoneDomain}`);
	return host.slice(0, -(zone.length + 1));
}

export function planBunnyReconciliation(
	records: BunnyRecord[],
	name: string,
	desired: string[],
	providerRecordIds: string[],
) {
	if (desired.length === 0) return { remove: [], add: [] };

	const knownIds = new Set(providerRecordIds);
	const managed = records.filter(
		(record) =>
			record.Type === 0 &&
			(record.Name ?? "").toLowerCase() === name.toLowerCase() &&
			(knownIds.has(String(record.Id)) || record.Comment === MANAGED_COMMENT),
	);
	const desiredSet = new Set(desired);
	const retained = new Set<string>();
	const remove: BunnyRecord[] = [];
	for (const record of managed) {
		if (
			!record.Value ||
			!desiredSet.has(record.Value) ||
			retained.has(record.Value)
		)
			remove.push(record);
		else retained.add(record.Value);
	}
	return { remove, add: desired.filter((ip) => !retained.has(ip)) };
}

async function request<T>(
	path: string,
	key: string,
	init?: RequestInit,
): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		...init,
		headers: {
			AccessKey: key,
			"Content-Type": "application/json",
			...init?.headers,
		},
	});
	if (!response.ok) {
		let detail = response.statusText;
		try {
			const body = (await response.json()) as {
				Message?: string;
				message?: string;
			};
			detail = body.Message ?? body.message ?? detail;
		} catch {}
		throw new Error(`Bunny DNS request failed (${response.status}): ${detail}`);
	}
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	return text ? (JSON.parse(text) as T) : (undefined as T);
}

export async function validateBunnyConnection(
	zoneId: string,
	key: string,
	hostname: string,
) {
	const zone = await request<{ Domain: string; Records?: BunnyRecord[] }>(
		`/dnszone/${encodeURIComponent(zoneId)}`,
		key,
	);
	const name = deriveBunnyRecordName(hostname, zone.Domain);
	const exactARecords = (zone.Records ?? []).filter(
		(record) =>
			record.Type === 0 &&
			(record.Name ?? "").toLowerCase() === name.toLowerCase(),
	);
	return { zoneDomain: zone.Domain, name, exactARecords };
}

export async function reconcileBunny(
	config: EdgeDnsConfig,
	key: string,
	hostname: string,
	desired: string[],
	providerRecordIds: string[],
) {
	const zone = await request<{ Domain: string; Records: BunnyRecord[] }>(
		`/dnszone/${encodeURIComponent(config.zoneId)}`,
		key,
	);
	const name = deriveBunnyRecordName(hostname, zone.Domain);
	const plan = planBunnyReconciliation(
		zone.Records ?? [],
		name,
		desired,
		providerRecordIds,
	);
	const knownIds = new Set(providerRecordIds);
	for (const ip of plan.add) {
		const created = await request<{ Id: number }>(
			`/dnszone/${config.zoneId}/records`,
			key,
			{
				method: "PUT",
				body: JSON.stringify({
					Type: 0,
					Name: name,
					Value: ip,
					Comment: MANAGED_COMMENT,
				}),
			},
		);
		knownIds.add(String(created.Id));
	}
	for (const record of plan.remove)
		await request(`/dnszone/${config.zoneId}/records/${record.Id}`, key, {
			method: "DELETE",
		});
	const current = await request<{ Records: BunnyRecord[] }>(
		`/dnszone/${encodeURIComponent(config.zoneId)}`,
		key,
	);
	const records = (current.Records ?? []).filter(
		(r) =>
			r.Type === 0 &&
			(r.Name ?? "").toLowerCase() === name.toLowerCase() &&
			(knownIds.has(String(r.Id)) || r.Comment === MANAGED_COMMENT),
	);
	return {
		currentTargets: [
			...new Set(records.flatMap((record) => record.Value ?? [])),
		].sort(),
		providerRecordIds: records.map((r) => String(r.Id)),
	};
}
