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
ALTER TABLE "artifactRevisions" ADD COLUMN "formatVersion" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "seqFrom" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "seqTo" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD COLUMN "blockIndex" jsonb;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "publishedSeq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentDrafts" ADD CONSTRAINT "documentDrafts_updatedByUserId_user_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentOperations" ADD CONSTRAINT "documentOperations_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documentOperations_artifactId_seq_unique" ON "documentOperations" USING btree ("artifactId","seq") WHERE "result" = 'applied';--> statement-breakpoint
CREATE UNIQUE INDEX "documentOperations_idempotencyKey_unique" ON "documentOperations" USING btree ("idempotencyKey");--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_formatVersion_check" CHECK ("formatVersion" >= 1);--> statement-breakpoint
ALTER TABLE "artifactRevisions" ADD CONSTRAINT "artifactRevisions_seqRange_check" CHECK ("seqFrom" >= 0 and "seqTo" >= "seqFrom");--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_publishedSeq_check" CHECK ("publishedSeq" >= 0);