ALTER TABLE "server" ADD COLUMN "status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "server" ADD COLUMN "configuration" text;