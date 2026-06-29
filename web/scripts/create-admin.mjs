#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";

const email = process.argv[2]?.trim().toLowerCase();

function usage() {
	console.error("Usage: pnpm admin:create <email>");
}

function isEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function displayNameForEmail(value) {
	return value.split("@")[0] || "Admin";
}

if (!email || !isEmail(email)) {
	usage();
	process.exit(1);
}

if (!process.env.DATABASE_URL) {
	console.error("DATABASE_URL is required.");
	process.exit(1);
}

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
});

const password = randomBytes(24).toString("base64url");
const userId = randomUUID();
const accountId = randomUUID();
const passwordHash = await hashPassword(password);
const client = await pool.connect();

try {
	await client.query("begin");

	const adminResult = await client.query(
		'select id from "user" where role = $1 limit 1',
		["admin"],
	);

	if (adminResult.rowCount > 0) {
		throw new Error("An admin user already exists.");
	}

	const existingUserResult = await client.query(
		'select id from "user" where lower(email) = $1 limit 1',
		[email],
	);

	if (existingUserResult.rowCount > 0) {
		throw new Error(
			`A user with email ${email} already exists. Promote that user manually or choose a different email.`,
		);
	}

	await client.query(
		`insert into "user"
			(id, name, email, email_verified, role, created_at, updated_at)
			values ($1, $2, $3, true, 'admin', now(), now())`,
		[userId, displayNameForEmail(email), email],
	);

	await client.query(
		`insert into account
			(id, account_id, provider_id, user_id, password, created_at, updated_at)
			values ($1, $2, 'credential', $3, $4, now(), now())`,
		[accountId, userId, userId, passwordHash],
	);

	await client.query("commit");

	console.log("Created admin user");
	console.log(`Email: ${email}`);
	console.log(`Password: ${password}`);
	console.log("Store this password now. It will not be shown again.");
} catch (error) {
	await client.query("rollback").catch(() => {});
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	client.release();
	await pool.end();
}
