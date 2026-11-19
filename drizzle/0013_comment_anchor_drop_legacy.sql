ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_anchorStartLine_check";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_anchorStartCol_check";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_anchorEndLine_check";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_anchorEndCol_check";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP COLUMN "anchorStartLine";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP COLUMN "anchorStartCol";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP COLUMN "anchorEndLine";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP COLUMN "anchorEndCol";--> statement-breakpoint
ALTER TABLE "artifactComments" DROP COLUMN "quotedText";