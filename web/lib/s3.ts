import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getBackupStorageConfig } from "@/db/queries";

const DEFAULT_S3_DELETE_TIMEOUT_MS = 60000;

let cachedClient: S3Client | null = null;
let cachedConfigHash: string | null = null;

function hashConfig(config: {
	region: string;
	endpoint: string | null;
	accessKey: string;
	secretKey: string;
}): string {
	return `${config.region}-${config.endpoint}-${config.accessKey}-${config.secretKey}`;
}

function getS3DeleteTimeoutMs(): number {
	const configuredTimeout = Number(process.env.S3_DELETE_TIMEOUT_MS);
	if (Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
		return configuredTimeout;
	}

	return DEFAULT_S3_DELETE_TIMEOUT_MS;
}

async function getS3Client(): Promise<S3Client | null> {
	const config = await getBackupStorageConfig();
	if (!config) {
		return null;
	}

	const configHash = hashConfig(config);
	if (cachedClient && cachedConfigHash === configHash) {
		return cachedClient;
	}

	cachedClient = new S3Client({
		region: config.region,
		credentials: {
			accessKeyId: config.accessKey,
			secretAccessKey: config.secretKey,
		},
		...(config.endpoint && {
			endpoint: config.endpoint,
			forcePathStyle: true,
		}),
	});
	cachedConfigHash = configHash;

	return cachedClient;
}

export async function deleteFromS3(
	bucket: string,
	key: string,
	timeoutMs = getS3DeleteTimeoutMs(),
): Promise<void> {
	const client = await getS3Client();
	if (!client) {
		throw new Error("S3 client not configured");
	}

	const abortSignal = AbortSignal.timeout(timeoutMs);

	await client.send(
		new DeleteObjectCommand({
			Bucket: bucket,
			Key: key,
		}),
		{ abortSignal },
	);
}
