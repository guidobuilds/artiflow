CREATE TABLE "instanceSecret" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "instanceSetting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedBy" text
);
