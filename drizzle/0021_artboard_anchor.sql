ALTER TABLE "artifactComments" DROP CONSTRAINT "artifactComments_anchor_kind_check";--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_anchor_kind_check" CHECK ("anchor" is null or "anchor" ->> 'kind' in ('text-range', 'element', 'page-point', 'board-point', 'slide-point', 'artboard-point'));
