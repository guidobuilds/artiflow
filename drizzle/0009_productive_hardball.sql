CREATE TABLE "artifactComments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifactId" text NOT NULL,
	"authorId" text NOT NULL,
	"parentId" uuid,
	"anchorStartLine" integer NOT NULL,
	"anchorStartCol" integer NOT NULL,
	"anchorEndLine" integer NOT NULL,
	"anchorEndCol" integer NOT NULL,
	"quotedText" text NOT NULL,
	"body" text NOT NULL,
	"resolvedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactComments_anchorStartLine_check" CHECK ("anchorStartLine" >= 1),
	CONSTRAINT "artifactComments_anchorStartCol_check" CHECK ("anchorStartCol" >= 1),
	CONSTRAINT "artifactComments_anchorEndLine_check" CHECK ("anchorEndLine" >= "anchorStartLine"),
	CONSTRAINT "artifactComments_anchorEndCol_check" CHECK ("anchorEndCol" >= 1),
	CONSTRAINT "artifactComments_body_cap_check" CHECK (char_length("body") <= 4000),
	CONSTRAINT "artifactComments_quote_cap_check" CHECK (char_length("quotedText") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_authorId_user_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactComments" ADD CONSTRAINT "artifactComments_parentId_artifactComments_id_fk" FOREIGN KEY ("parentId") REFERENCES "public"."artifactComments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifactComments_artifactId_idx" ON "artifactComments" USING btree ("artifactId");--> statement-breakpoint
CREATE INDEX "artifactComments_parentId_idx" ON "artifactComments" USING btree ("parentId");