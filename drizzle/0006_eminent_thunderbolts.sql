CREATE TABLE "artifactPublicLinks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"revokedAt" timestamp with time zone,
	"rotatedFromId" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifactShares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" text NOT NULL,
	"sharedWithUserId" text NOT NULL,
	"grantedByUserId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifactPublicLinks" ADD CONSTRAINT "artifactPublicLinks_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactPublicLinks" ADD CONSTRAINT "artifactPublicLinks_rotatedFromId_artifactPublicLinks_id_fk" FOREIGN KEY ("rotatedFromId") REFERENCES "public"."artifactPublicLinks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactShares" ADD CONSTRAINT "artifactShares_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactShares" ADD CONSTRAINT "artifactShares_sharedWithUserId_user_id_fk" FOREIGN KEY ("sharedWithUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactShares" ADD CONSTRAINT "artifactShares_grantedByUserId_user_id_fk" FOREIGN KEY ("grantedByUserId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifactPublicLinks_tokenHash_unique" ON "artifactPublicLinks" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "artifactPublicLinks_artifactId_idx" ON "artifactPublicLinks" USING btree ("artifactId");--> statement-breakpoint
CREATE UNIQUE INDEX "artifactShares_artifactId_sharedWithUserId_unique" ON "artifactShares" USING btree ("artifactId","sharedWithUserId");--> statement-breakpoint
CREATE INDEX "artifactShares_sharedWithUserId_idx" ON "artifactShares" USING btree ("sharedWithUserId");--> statement-breakpoint
CREATE INDEX "artifactShares_artifactId_idx" ON "artifactShares" USING btree ("artifactId");