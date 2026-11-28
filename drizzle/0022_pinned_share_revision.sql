ALTER TABLE "artifactPublicLinks" ADD COLUMN "pinnedRevisionId" text;--> statement-breakpoint
ALTER TABLE "artifactPublicLinks" ADD CONSTRAINT "artifactPublicLinks_pinnedRevisionId_artifactRevisions_id_fk" FOREIGN KEY ("pinnedRevisionId") REFERENCES "public"."artifactRevisions"("id") ON DELETE cascade ON UPDATE no action;
