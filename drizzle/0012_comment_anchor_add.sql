ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_quote_cap_check";--> statement-breakpoint
ALTER TABLE "artifactComments" ADD COLUMN "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD COLUMN "revisionId" text;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD COLUMN "resolvedBy" text;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_revisionId_artifactRevisions_id_fk" FOREIGN KEY ("revisionId") REFERENCES "public"."artifactRevisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_resolvedBy_user_id_fk" FOREIGN KEY ("resolvedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "artifactComments"
SET "anchor" = jsonb_build_object(
  'kind',
  'text-range',
  'startLine',
  "anchorStartLine",
  'startCol',
  "anchorStartCol",
  'endLine',
  "anchorEndLine",
  'endCol',
  "anchorEndCol",
  'quotedText',
  "quotedText"
)
WHERE "parentId" IS NULL;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_root_anchor_check" CHECK (("parentId" is null and "anchor" is not null) or ("parentId" is not null and "anchor" is null));--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_anchor_kind_check" CHECK ("anchor" is null or "anchor" ->> 'kind' in ('text-range', 'element', 'page-point', 'board-point', 'slide-point'));--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_quote_cap_check" CHECK ("anchor" is null or char_length("anchor" ->> 'quotedText') <= 2000);
