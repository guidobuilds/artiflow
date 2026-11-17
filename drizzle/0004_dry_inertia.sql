ALTER TABLE "artifacts" ADD COLUMN "currentRevisionId" text;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "observedSizeBytes" integer;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_currentRevisionId_artifactRevisions_id_fk" FOREIGN KEY ("currentRevisionId") REFERENCES "public"."artifactRevisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_observedSizeBytes_cap_check" CHECK ("observedSizeBytes" <= 16777216);