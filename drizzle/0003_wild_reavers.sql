CREATE INDEX "artifactUploads_ownerId_idx" ON "artifactUploads" USING btree ("ownerId");--> statement-breakpoint
CREATE INDEX "artifacts_ownerId_idx" ON "artifacts" USING btree ("ownerId");