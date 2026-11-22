ALTER TABLE "user" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deactivatedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "deactivatedBy" text;