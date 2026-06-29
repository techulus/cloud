#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Pool } from "pg";

const rawCommand = process.argv[2];
const email = process.argv[3]?.trim().toLowerCase();

function normalizeCommand(value) {
	if (value === "create" || value === "--create") {
		return "create";
	}
	if (value === "reset-password" || value === "--reset-password") {
		return "reset-password";
	}
	return null;
}

function usage() {
	console.error(`Usage:
  pnpm admin --create <email>
  pnpm admin --reset-password <email>
  pnpm admin:create <email>
  pnpm admin:reset-password <email>`);
}

function isEmail(value) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function displayNameForEmail(value) {
	return value.split("@")[0] || "Admin";
}

function generatePassword() {
	return randomBytes(24).toString("base64url");
}

const command = normalizeCommand(rawCommand);

if (!command || !email || !isEmail(email)) {
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

async function lockAdminAccountTool(client) {
	await client.query("select pg_advisory_xact_lock(74001, 1)");
}

async function getAdmins(client) {
	const result = await client.query(
		'select id, email from "user" where role = $1 order by created_at asc',
		["admin"],
	);
	return result.rows;
}

async function createAdmin(client, adminEmail) {
	const admins = await getAdmins(client);
	if (admins.length > 0) {
		throw new Error("An admin user already exists.");
	}

	const existingUserResult = await client.query(
		'select id from "user" where lower(email) = $1 limit 1',
		[adminEmail],
	);

	if (existingUserResult.rowCount > 0) {
		throw new Error(
			`A user with email ${adminEmail} already exists. Promote that user manually or choose a different email.`,
		);
	}

	const password = generatePassword();
	const userId = randomUUID();
	const accountId = randomUUID();
	const passwordHash = await hashPassword(password);

	await client.query(
		`insert into "user"
			(id, name, email, email_verified, role, created_at, updated_at)
			values ($1, $2, $3, true, 'admin', now(), now())`,
		[userId, displayNameForEmail(adminEmail), adminEmail],
	);

	await client.query(
		`insert into account
			(id, account_id, provider_id, user_id, password, created_at, updated_at)
			values ($1, $2, 'credential', $3, $4, now(), now())`,
		[accountId, userId, userId, passwordHash],
	);

	return {
		action: "Created admin user",
		email: adminEmail,
		password,
	};
}

async function resetAdminPassword(client, adminEmail) {
	const admins = await getAdmins(client);
	if (admins.length === 0) {
		throw new Error("No admin user exists. Create the first admin instead.");
	}
	if (admins.length > 1) {
		throw new Error(
			"Multiple admin users exist. Resolve the database state manually before resetting an admin password.",
		);
	}

	const [admin] = admins;
	if (admin.email.toLowerCase() !== adminEmail) {
		throw new Error(
			`The only admin user is ${admin.email}. Refusing to reset ${adminEmail}.`,
		);
	}

	const password = generatePassword();
	const passwordHash = await hashPassword(password);
	const updateResult = await client.query(
		`update account
			set password = $1, updated_at = now()
			where user_id = $2 and provider_id = 'credential'
			returning id`,
		[passwordHash, admin.id],
	);

	if (updateResult.rowCount === 0) {
		await client.query(
			`insert into account
				(id, account_id, provider_id, user_id, password, created_at, updated_at)
				values ($1, $2, 'credential', $3, $4, now(), now())`,
			[randomUUID(), admin.id, admin.id, passwordHash],
		);
	}

	return {
		action: "Reset admin password",
		email: adminEmail,
		password,
	};
}

async function run() {
	const client = await pool.connect();

	try {
		await client.query("begin");
		await lockAdminAccountTool(client);

		const result =
			command === "create"
				? await createAdmin(client, email)
				: await resetAdminPassword(client, email);

		await client.query("commit");

		console.log(result.action);
		console.log(`Email: ${result.email}`);
		console.log(`Password: ${result.password}`);
		console.log("Store this password now. It will not be shown again.");
	} catch (error) {
		await client.query("rollback").catch(() => {});
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		client.release();
		await pool.end();
	}
}

await run();
