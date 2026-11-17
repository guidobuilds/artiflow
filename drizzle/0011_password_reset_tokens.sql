CREATE TABLE "passwordResetToken" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"consumedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passwordResetToken_tokenHash_unique" UNIQUE("tokenHash"),
	CONSTRAINT "passwordResetToken_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "passwordResetToken" ADD CONSTRAINT "passwordResetToken_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "passwordResetToken_userId_idx" ON "passwordResetToken" USING btree ("userId");