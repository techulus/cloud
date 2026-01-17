import { randomUUID } from "node:crypto";
import * as acme from "acme-client";
import { eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { acmeChallenges, domainCertificates, settings } from "@/db/schema";
import { getSetting } from "@/db/queries";
import { SETTING_KEYS } from "@/lib/settings-keys";

const ACME_ACCOUNT_KEY_SETTING = "acme_account_key";
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

let acmeClient: acme.Client | null = null;

async function getOrCreateAccountKey(): Promise<Buffer> {
	const existing = await db
		.select()
		.from(settings)
		.where(eq(settings.key, ACME_ACCOUNT_KEY_SETTING));

	if (existing[0]?.value) {
		return Buffer.from(existing[0].value as string, "base64");
	}

	const newKey = await acme.crypto.createPrivateKey();
	await db
		.insert(settings)
		.values({
			key: ACME_ACCOUNT_KEY_SETTING,
			value: newKey.toString("base64"),
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: newKey.toString("base64") },
		});

	return newKey;
}

async function getAcmeClient(): Promise<acme.Client> {
	if (acmeClient) {
		return acmeClient;
	}

	const accountKey = await getOrCreateAccountKey();
	const directoryUrl =
		process.env.ACME_DIRECTORY_URL || acme.directory.letsencrypt.production;

	acmeClient = new acme.Client({
		directoryUrl,
		accountKey,
	});

	return acmeClient;
}

async function storeChallenge(
	token: string,
	keyAuthorization: string,
): Promise<void> {
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
	await db
		.insert(acmeChallenges)
		.values({
			token,
			keyAuthorization,
			expiresAt,
		})
		.onConflictDoUpdate({
			target: acmeChallenges.token,
			set: { keyAuthorization, expiresAt },
		});
}

async function removeChallenge(token: string): Promise<void> {
	await db.delete(acmeChallenges).where(eq(acmeChallenges.token, token));
}

export async function issueCertificate(domain: string): Promise<{
	certificate: string;
	privateKey: string;
	expiresAt: Date;
}> {
	console.log(`[acme] starting certificate issuance for ${domain}`);
	const client = await getAcmeClient();
	const email = await getSetting<string>(SETTING_KEYS.ACME_EMAIL);

	if (!email) {
		throw new Error("ACME email is not configured. Please set it in Settings > Infrastructure.");
	}

	const [privateKey, csr] = await acme.crypto.createCsr({
		commonName: domain,
	});

	console.log(`[acme] created CSR for ${domain}, starting ACME flow`);

	const cert = await client.auto({
		csr,
		email,
		termsOfServiceAgreed: true,
		challengeCreateFn: async (authz, challenge, keyAuthorization) => {
			void authz;
			console.log(
				`[acme] storing challenge for ${domain}: token=${challenge.token}`,
			);
			await storeChallenge(challenge.token, keyAuthorization);
			console.log(
				`[acme] challenge stored, waiting for validation at http://${domain}/.well-known/acme-challenge/${challenge.token}`,
			);
		},
		challengeRemoveFn: async (authz, challenge) => {
			void authz;
			console.log(
				`[acme] removing challenge for ${domain}: token=${challenge.token}`,
			);
			await removeChallenge(challenge.token);
		},
		challengePriority: ["http-01"],
	});

	console.log(`[acme] certificate issued successfully for ${domain}`);

	const certInfo = acme.crypto.readCertificateInfo(cert);
	const expiresAt = certInfo.notAfter;

	console.log(
		`[acme] certificate for ${domain} expires at ${expiresAt.toISOString()}`,
	);

	await db
		.insert(domainCertificates)
		.values({
			id: randomUUID(),
			domain,
			certificate: cert,
			certificateKey: privateKey.toString(),
			expiresAt,
			issuedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: domainCertificates.domain,
			set: {
				certificate: cert,
				certificateKey: privateKey.toString(),
				expiresAt,
				issuedAt: new Date(),
			},
		});

	return {
		certificate: cert,
		privateKey: privateKey.toString(),
		expiresAt,
	};
}

export async function getCertificate(domain: string): Promise<{
	certificate: string;
	certificateKey: string;
	expiresAt: Date;
} | null> {
	const result = await db
		.select()
		.from(domainCertificates)
		.where(eq(domainCertificates.domain, domain));

	if (!result[0]) {
		return null;
	}

	return {
		certificate: result[0].certificate,
		certificateKey: result[0].certificateKey,
		expiresAt: result[0].expiresAt,
	};
}

export async function getChallenge(
	token: string,
): Promise<{ keyAuthorization: string } | null> {
	const result = await db
		.select()
		.from(acmeChallenges)
		.where(eq(acmeChallenges.token, token));

	console.log(`[getChallenge] token=${token} found=${!!result[0]}`);
	if (result[0]) {
		console.log(
			`[getChallenge] expires_at=${result[0].expiresAt}, now=${new Date()}, valid=${new Date() < result[0].expiresAt}`,
		);
	}

	if (!result[0] || new Date() > result[0].expiresAt) {
		return null;
	}

	return { keyAuthorization: result[0].keyAuthorization };
}

export async function renewExpiringCertificates(): Promise<void> {
	const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

	const expiring = await db
		.select()
		.from(domainCertificates)
		.where(lt(domainCertificates.expiresAt, thirtyDaysFromNow));

	for (const cert of expiring) {
		try {
			await issueCertificate(cert.domain);
			console.log(`[acme] renewed certificate for ${cert.domain}`);
		} catch (error) {
			console.error(`[acme] failed to renew ${cert.domain}:`, error);
		}
	}
}

export async function cleanupExpiredChallenges(): Promise<void> {
	await db
		.delete(acmeChallenges)
		.where(lt(acmeChallenges.expiresAt, new Date()));
}

export async function getAllCertificatesForDomains(domains: string[]): Promise<
	Array<{
		domain: string;
		certificate: string;
		certificateKey: string;
	}>
> {
	if (domains.length === 0) {
		return [];
	}

	const certs = await db.select().from(domainCertificates);

	return certs
		.filter((c) => domains.includes(c.domain))
		.map((c) => ({
			domain: c.domain,
			certificate: c.certificate,
			certificateKey: c.certificateKey,
		}));
}
