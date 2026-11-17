import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./apps/api/src/adapters/postgres/db/schema.ts",
    "./apps/api/src/adapters/postgres/db/oauth-schema.ts",
    "./apps/api/src/adapters/postgres/db/artifact-schema.ts",
    "./apps/api/src/adapters/postgres/db/invite-schema.ts",
    "./apps/api/src/adapters/postgres/db/password-reset-schema.ts",
  ],
  out: "./drizzle",
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
});
