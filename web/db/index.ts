import { createClient } from "@libsql/client";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import * as schema from "./schema";

const client = createClient({
	url: process.env.TURSO_DATABASE_URL ?? "file:./data/sqlite.db",
	authToken: process.env.TURSO_AUTH_TOKEN,
});

export const db = drizzleLibsql(client, { schema });
