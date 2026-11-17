CREATE TABLE "artifactChunks" (
	"id" text PRIMARY KEY NOT NULL,
	"uploadId" text NOT NULL,
	"chunkIndex" integer NOT NULL,
	"sizeBytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactChunks_sizeBytes_cap_check" CHECK ("sizeBytes" <= 1048576),
	CONSTRAINT "artifactChunks_sha256_hex_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "artifactRevisions" (
	"id" text PRIMARY KEY NOT NULL,
	"artifactId" text NOT NULL,
	"revision" integer NOT NULL,
	"sizeBytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storageKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactRevisions_storageKey_unique" UNIQUE("storageKey"),
	CONSTRAINT "artifactRevisions_sizeBytes_cap_check" CHECK ("sizeBytes" <= 16777216),
	CONSTRAINT "artifactRevisions_sha256_hex_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "artifactUploads" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"declaredSizeBytes" integer NOT NULL,
	"declaredSha256" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactUploads_status_check" CHECK ("status" in ('open', 'complete', 'aborted')),
	CONSTRAINT "artifactUploads_declaredSha256_hex_check" CHECK ("declaredSha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"ownerId" text NOT NULL,
	"title" text,
	"deletedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artifactChunks" ADD CONSTRAINT "artifactChunks_uploadId_artifactUploads_id_fk" FOREIGN KEY ("uploadId") REFERENCES "public"."artifactUploads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactUploads" ADD CONSTRAINT "artifactUploads_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_ownerId_user_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifactChunks_uploadId_idx" ON "artifactChunks" USING btree ("uploadId");--> statement-breakpoint
CREATE UNIQUE INDEX "artifactChunks_uploadId_chunkIndex_unique" ON "artifactChunks" USING btree ("uploadId","chunkIndex");--> statement-breakpoint
CREATE UNIQUE INDEX "artifactRevisions_artifactId_revision_unique" ON "artifactRevisions" USING btree ("artifactId","revision");--> statement-breakpoint
CREATE INDEX "artifactUploads_expiresAt_idx" ON "artifactUploads" USING btree ("expiresAt");