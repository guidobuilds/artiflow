CREATE TABLE "registrationInvite" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registrationInvite_tokenHash_unique" UNIQUE("tokenHash"),
	CONSTRAINT "registrationInvite_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "registrationInvite_email_check" CHECK ("email" = lower(btrim("email")))
);
--> statement-breakpoint
CREATE INDEX "registrationInvite_email_idx" ON "registrationInvite" USING btree ("email");