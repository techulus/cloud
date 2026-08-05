import * as Sentry from "@sentry/nextjs";
import { redactSentryEvent } from "@/lib/sentry";

const dsn = process.env.SENTRY_DSN;

Sentry.init({
	beforeSend: redactSentryEvent,
	dsn,
	enabled: Boolean(dsn),
});
