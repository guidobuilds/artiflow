CREATE TABLE "artifactAssets" (
	"artifactId" text NOT NULL,
	"assetSha256" text NOT NULL,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactAssets_artifactId_assetSha256_pk" PRIMARY KEY("artifactId","assetSha256")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"sha256" text PRIMARY KEY NOT NULL,
	"sizeBytes" integer NOT NULL,
	"contentType" text NOT NULL,
	"storageKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_sizeBytes_cap_check" CHECK ("sizeBytes" <= 2097152),
	CONSTRAINT "assets_sha256_hex_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assets_contentType_check" CHECK ("contentType" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'))
);
--> statement-breakpoint
CREATE TABLE "documentDrafts" (
	"artifactId" text PRIMARY KEY NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"formatVersion" integer DEFAULT 1 NOT NULL,
	"state" jsonb NOT NULL,
	"updatedByUserId" text,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentDrafts_seq_check" CHECK ("seq" >= 0),
	CONSTRAINT "documentDrafts_formatVersion_check" CHECK ("formatVersion" >= 1)
);
--> statement-breakpoint
CREATE TABLE "documentOperations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" text NOT NULL,
	"seq" integer NOT NULL,
	"baseSeq" integer NOT NULL,
	"authorKind" text NOT NULL,
	"authorId" text NOT NULL,
	"ops" jsonb NOT NULL,
	"result" text NOT NULL,
	"idempotencyKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentOperations_seq_check" CHECK ("seq" >= 0),
	CONSTRAINT "documentOperations_baseSeq_check" CHECK ("baseSeq" >= 0),
	CONSTRAINT "documentOperations_authorKind_check" CHECK ("authorKind" in ('person', 'agent')),
	CONSTRAINT "documentOperations_result_check" CHECK ("result" in ('applied', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_kind_check", ADD CONSTRAINT "artifacts_kind_check" CHECK ("kind" in ('html', 'markdown', 'canvas', 'deck'));--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "formatVersion" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "seqFrom" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "seqTo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "blockIndex" jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "publishedSeq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactAssets" ADD CONSTRAINT "artifactAssets_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactAssets" ADD CONSTRAINT "artifactAssets_assetSha256_assets_sha256_fk" FOREIGN KEY ("assetSha256") REFERENCES "public"."assets"("sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_updatedByUserId_user_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentOperations" ADD CONSTRAINT "documentOperations_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifactAssets_assetSha256_idx" ON "artifactAssets" USING btree ("assetSha256");--> statement-breakpoint
CREATE UNIQUE INDEX "documentOperations_artifactId_seq_unique" ON "documentOperations" USING btree ("artifactId","seq") WHERE "result" = 'applied';--> statement-breakpoint
CREATE UNIQUE INDEX "documentOperations_idempotencyKey_unique" ON "documentOperations" USING btree ("idempotencyKey");--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_formatVersion_check" CHECK ("formatVersion" >= 1);--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_seqRange_check" CHECK ("seqFrom" >= 0 and "seqTo" >= "seqFrom");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_publishedSeq_check" CHECK ("publishedSeq" >= 0);