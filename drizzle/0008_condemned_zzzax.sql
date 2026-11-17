ALTER TABLE "artifactShares" ADD COLUMN "role" text DEFAULT 'reader' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "kind" text DEFAULT 'html' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifactShares" ADD CONSTRAINT "artifactShares_role_check" CHECK ("role" in ('reader', 'editor', 'commenter'));--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_kind_check" CHECK ("kind" in ('html', 'markdown'));