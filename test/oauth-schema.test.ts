import assert from "node:assert/strict";
import { test } from "node:test";

import { oauthProvider } from "@better-auth/oauth-provider";
import { getAuthTables } from "better-auth/db";
import { jwt } from "better-auth/plugins";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

import { authSchema } from "../apps/api/src/adapters/postgres/db/auth-schema.ts";
import { oauthSchema } from "../apps/api/src/adapters/postgres/db/oauth-schema.ts";

const PUBLIC_ORIGIN = "http://127.0.0.1:5173";
const BASE_MODELS = ["user", "session", "account", "verification"];
const DATA_TYPES: Record<string, string> = {
  string: "string",
  "string[]": "array",
  boolean: "boolean",
  number: "number",
  date: "date",
  json: "json",
};

type Field = {
  type: string;
  required?: boolean;
  unique?: boolean;
  references?: { model: string; field: string; onDelete?: string };
};
type Model = {
  modelName?: string;
  fields: Record<string, Field>;
  indexes?: { fields: string[]; unique?: boolean }[];
};

const pluginModels = getAuthTables({
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: `${PUBLIC_ORIGIN}/login`,
      consentPage: `${PUBLIC_ORIGIN}/consent`,
      resources: [`${PUBLIC_ORIGIN}/mcp`],
      allowDynamicClientRegistration: true,
    }),
  ],
}) as unknown as Record<string, Model>;
const oauthModels = Object.entries(pluginModels).filter(([name]) => !BASE_MODELS.includes(name));
const tables = oauthSchema as unknown as Record<string, PgTable>;
const expectedFields = (model: Model) =>
  ({ id: { type: "string", required: true }, ...model.fields }) as Record<string, Field>;
const configOf = (model: string) => {
  const table = tables[model];
  assert.ok(table, `Drizzle OAuth schema is missing the "${model}" model`);
  return getTableConfig(table);
};

test("every plugin model is mapped with its exact columns, nullability and type", () => {
  assert.deepEqual(
    oauthModels.map(([name]) => name).sort(),
    Object.keys(tables)
      .filter((name) => name !== "oauthSchema")
      .sort(),
  );
  for (const [model, definition] of oauthModels) {
    const config = configOf(model);
    assert.equal(config.name, definition.modelName ?? model);
    const fields = expectedFields(definition);
    const columns = new Map(config.columns.map((column) => [column.name, column]));
    assert.deepEqual([...columns.keys()].sort(), Object.keys(fields).sort(), `${model} columns`);
    for (const [name, field] of Object.entries(fields)) {
      const column = columns.get(name);
      assert.ok(column, `${model}.${name} column`);
      assert.equal(column.notNull, field.required !== false, `${model}.${name} nullability`);
      assert.equal(column.dataType, DATA_TYPES[field.type], `${model}.${name} type`);
      if (field.unique) assert.equal(column.isUnique, true, `${model}.${name} uniqueness`);
    }
  }
});

test("references follow the plugin's target table, key and delete action", () => {
  for (const [model, definition] of oauthModels) {
    const config = configOf(model);
    for (const [name, field] of Object.entries(definition.fields)) {
      if (!field.references) continue;
      const foreign = config.foreignKeys.find((key) => key.reference().columns.some((column) => column.name === name));
      assert.ok(foreign, `${model}.${name} foreign key`);
      const reference = foreign.reference();
      const target = pluginModels[field.references.model] as Model;
      assert.equal(getTableConfig(reference.foreignTable).name, target.modelName ?? field.references.model);
      assert.deepEqual(
        reference.foreignColumns.map((column) => column.name),
        [field.references.field],
      );
      assert.equal(foreign.onDelete, field.references.onDelete ?? "no action", `${model}.${name} on delete`);
    }
  }
});

const indexColumns = (indexed: { config: { columns: unknown[] } }) =>
  indexed.config.columns
    .map((column) => ("name" in (column as object) ? String((column as { name: string }).name) : ""))
    .sort()
    .join(",");

test("composite uniqueness declared by the plugin is present", () => {
  for (const [model, definition] of oauthModels) {
    const config = configOf(model);
    for (const declared of definition.indexes ?? []) {
      const wanted = [...declared.fields].sort().join(",");
      const found = config.indexes.some(
        (declaredIndex) =>
          indexColumns(declaredIndex) === wanted && Boolean(declaredIndex.config.unique) === Boolean(declared.unique),
      );
      assert.equal(found, true, `${model} index on ${wanted}`);
    }
  }
});

test("authSchema aggregates the unchanged base tables with the OAuth tables", () => {
  assert.deepEqual(
    Object.keys(authSchema).sort(),
    [...BASE_MODELS, ...Object.keys(tables).filter((name) => name !== "oauthSchema")].sort(),
  );
});
