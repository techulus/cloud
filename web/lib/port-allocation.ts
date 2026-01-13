import { db } from "@/db";
import { servicePorts } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

const TCP_PORT_START = 10000;
const TCP_PORT_END = 10999;
const UDP_PORT_START = 11000;
const UDP_PORT_END = 11999;

export async function allocatePort(
	protocol: "tcp" | "udp",
): Promise<number> {
	const portStart = protocol === "tcp" ? TCP_PORT_START : UDP_PORT_START;
	const portEnd = protocol === "tcp" ? TCP_PORT_END : UDP_PORT_END;

	const usedPorts = await db
		.select({ port: servicePorts.externalPort })
		.from(servicePorts)
		.where(eq(servicePorts.protocol, protocol))
		.orderBy(asc(servicePorts.externalPort));

	const usedSet = new Set(
		usedPorts.map((p) => p.port).filter((p): p is number => p !== null),
	);

	for (let port = portStart; port <= portEnd; port++) {
		if (!usedSet.has(port)) {
			return port;
		}
	}

	throw new Error(
		`No available ${protocol.toUpperCase()} ports. Range ${portStart}-${portEnd} exhausted.`,
	);
}
