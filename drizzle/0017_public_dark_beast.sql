CREATE TABLE "artifactAssets" (
	"artifactId" text NOT NULL,
	"assetSha256" text NOT NULL,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifactAssets_artifactId_assetSha256_pk" PRIMARY KEY("artifactId","assetSha256")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"sha256" text PRIMARY KEY NOT NULL,
	"sizeBytes" integer NOT NULL,
	"contentType" text NOT NULL,
	"storageKey" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_sizeBytes_cap_check" CHECK ("sizeBytes" <= 2097152),
	CONSTRAINT "assets_sha256_hex_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "assets_contentType_check" CHECK ("contentType" in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'))
);
--> statement-breakpoint
ALTER TABLE "artifactAssets" ADD CONSTRAINT "artifactAssets_artifactId_artifacts_id_fk" FOREIGN KEY ("artifactId") REFERENCES "public"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifactAssets" ADD CONSTRAINT "artifactAssets_assetSha256_assets_sha256_fk" FOREIGN KEY ("assetSha256") REFERENCES "public"."assets"("sha256") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifactAssets_assetSha256_idx" ON "artifactAssets" USING btree ("assetSha256");