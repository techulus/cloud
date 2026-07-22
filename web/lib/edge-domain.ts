export function getEdgeDomain() {
	return process.env.EDGE_DOMAIN?.trim().replace(/\.$/, "") || null;
}
