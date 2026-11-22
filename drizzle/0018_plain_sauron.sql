ALTER TABLE "registrationInvite" ADD COLUMN "revokedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrationInvite" ADD COLUMN "createdBy" text;--> statement-breakpoint
ALTER TABLE "registrationInvite" ADD COLUMN "userId" text;--> statement-breakpoint
ALTER TABLE "passwordResetToken" ADD COLUMN "createdBy" text;--> statement-breakpoint
ALTER TABLE "registrationInvite" ADD CONSTRAINT "registrationInvite_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrationInvite" ADD CONSTRAINT "registrationInvite_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwordResetToken" ADD CONSTRAINT "passwordResetToken_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;