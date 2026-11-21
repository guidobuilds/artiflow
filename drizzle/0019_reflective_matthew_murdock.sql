CREATE TABLE "ssoProvider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"oidcConfig" text,
	"samlConfig" text,
	"userId" text,
	"providerId" text NOT NULL,
	"organizationId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ssoProvider_providerId_unique" UNIQUE("providerId")
);
--> statement-breakpoint
ALTER TABLE "ssoProvider" ADD CONSTRAINT "ssoProvider_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ssoProvider_userId_idx" ON "ssoProvider" USING btree ("userId");