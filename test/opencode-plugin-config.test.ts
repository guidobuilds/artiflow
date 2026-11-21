import assert from "node:assert/strict";
import test from "node:test";
import { configUrl, optionalInstanceUrl, resolvedInstanceUrl, urlKey } from "../plugins/opencode/src/instance.ts";
import {
  setupCommand,
  setupCommandDescription,
  setupCommandName,
  setupMessage,
  setupRequiredMessage,
} from "../plugins/opencode/src/setup-command.ts";
import { guiConfig, guiConfigReader } from "../plugins/opencode/src/gui-core.ts";
import { Associated } from "../plugins/opencode/src/associated-rpc.ts";
import plugin from "../plugins/opencode/src/index.ts";

const message =
  "Configure artiflow.url (options.url) or ARTIFLOW_URL with an absolute http(s) origin without credentials, path, query, or fragment.";

const memory = (entries: Record<string, unknown> = {}) => {
  const stored = new Map<string, unknown>(Object.entries(entries));
  return {
    stored,
    get: async (key: string) => stored.get(key),
    set: async (key: string, value: unknown) => {
      stored.set(key, value);
    },
  };
};

function entry(initial: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const storage = memory(initial);
  const calls = { skills: 0, tools: 0 };
  const commands: { name: string; description?: string; execute: (input: unknown) => Promise<void> }[] = [];
  const reports: { sessionID: string; text: string }[] = [];
  const rpc: Record<string, (input: unknown, context: unknown) => Promise<unknown>> = {};
  const registration = { dispose: async () => {} };
  const ctx = {
    options,
    storage: {
      get: storage.get,
      set: storage.set,
      remove: async () => {},
      scan: async () => ({ entries: [] }),
    },
    rpc: {
      register: async (_definition: unknown, handlers: Record<string, (input: unknown) => Promise<unknown>>) => {
        Object.assign(rpc, handlers);
        return { ...registration, events: { emit: async () => {} } };
      },
    },
    command: {
      transform: async (callback: (editor: { add: (value: (typeof commands)[number]) => void }) => void) => {
        callback({ add: (value) => commands.push(value) });
        return registration;
      },
    },
    skill: {
      transform: async (callback: (editor: { add: (value: unknown) => void }) => void) => {
        calls.skills += 1;
        callback({ add: () => {} });
        return registration;
      },
    },
    tool: {
      transform: async (
        callback: (editor: { namespace: (value: unknown) => void; add: (value: unknown) => void }) => void,
      ) => {
        calls.tools += 1;
        callback({ namespace: () => {}, add: () => {} });
        return registration;
      },
    },
    session: {
      synthetic: async (input: { sessionID: string; text: string }) => {
        reports.push(input);
        return {};
      },
    },
  };
  return { ctx, storage, commands, reports, rpc, calls };
}

const withoutEnvironment = async (body: () => Promise<void>) => {
  const saved = process.env.ARTIFLOW_URL;
  delete process.env.ARTIFLOW_URL;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.ARTIFLOW_URL;
    else process.env.ARTIFLOW_URL = saved;
  }
};

test("the persisted URL is read from the server storage on the url key", async () => {
  assert.equal(urlKey, "url");
  const storage = memory({ url: "https://stored.example" });
  assert.equal(await resolvedInstanceUrl({ options: {}, env: undefined, storage }), "https://stored.example");
});

test("the resolution chain prefers options, then the persisted URL, then the environment", async () => {
  const storage = memory({ url: "https://stored.example" });
  assert.equal(
    await resolvedInstanceUrl({ options: { url: "https://option.example" }, env: "https://env.example", storage }),
    "https://option.example",
  );
  assert.equal(
    await resolvedInstanceUrl({ options: {}, env: "https://env.example", storage }),
    "https://stored.example",
  );
  assert.equal(
    await resolvedInstanceUrl({ options: {}, env: "https://env.example", storage: memory() }),
    "https://env.example",
  );
  assert.equal(await resolvedInstanceUrl({ options: {}, env: undefined, storage }), "https://stored.example");
});

test("an invalid persisted URL is rejected with the unchanged message", async () => {
  for (const value of [
    "ftp://example.com",
    "/relative",
    "https://user:secret@example.com",
    "https://example.com/path",
    42,
  ]) {
    const storage = memory({ url: value });
    await assert.rejects(resolvedInstanceUrl({ options: {}, env: undefined, storage }), { message });
  }
  assert.equal(
    await resolvedInstanceUrl({
      options: { url: "https://option.example" },
      env: undefined,
      storage: memory({ url: "nope" }),
    }),
    "https://option.example",
  );
});

test("config.url reports the resolved chain result and null when it cannot resolve", async () => {
  assert.deepEqual(
    await configUrl({ options: {}, env: "https://env.example", storage: memory({ url: "https://stored.example" }) }),
    { url: "https://stored.example" },
  );
  assert.deepEqual(
    await configUrl({ options: { url: "https://option.example" }, env: "https://env.example", storage: memory() }),
    { url: "https://option.example" },
  );
  assert.deepEqual(await configUrl({ options: {}, env: "https://env.example", storage: memory() }), {
    url: "https://env.example",
  });
  assert.deepEqual(await configUrl({ options: {}, env: undefined, storage: memory() }), { url: null });
  assert.deepEqual(await configUrl({ options: {}, env: undefined, storage: memory({ url: "not-an-origin" }) }), {
    url: null,
  });
});

test("config.url is a portable RPC method shaped like the other methods", async () => {
  const method = Associated.methods["config.url"];
  assert.ok(method);
  const input = method.input["~standard"];
  const output = method.output["~standard"];
  assert.deepEqual(await input.validate({}), { value: {} });
  assert.deepEqual(await output.validate({ url: "https://a.example" }), { value: { url: "https://a.example" } });
  assert.deepEqual(await output.validate({ url: null }), { value: { url: null } });
  assert.ok((await output.validate({ url: 1 })).issues);
  assert.ok((await output.validate({})).issues);
});

test("the server entry resolves a persisted URL and exposes it through config.url", async () => {
  await withoutEnvironment(async () => {
    const { ctx, rpc, commands, calls } = entry({ url: "https://stored.example" });
    const cleanup = await plugin.setup(ctx as never);
    assert.equal(typeof cleanup, "function");
    assert.deepEqual(await rpc["config.url"]?.({}, { signal: new AbortController().signal }), {
      url: "https://stored.example",
    });
    assert.deepEqual(
      commands.map((command) => command.name),
      [setupCommandName],
    );
    assert.equal(commands[0]?.description, setupCommandDescription);
    assert.equal(calls.tools, 1);
    assert.equal(calls.skills, 1);
    await cleanup?.();
  });
});

test("the server entry boots without any URL source so the setup command can provision one", async () => {
  await withoutEnvironment(async () => {
    const { ctx, commands, rpc, calls } = entry();
    const cleanup = await plugin.setup(ctx as never);
    assert.equal(typeof cleanup, "function");
    assert.deepEqual(
      commands.map((command) => command.name),
      [setupCommandName],
    );
    const context = { signal: new AbortController().signal };
    assert.deepEqual(await rpc["config.url"]?.({}, context), { url: null });
    assert.equal(await rpc["viewer.token"]?.({}, context), null);
    assert.deepEqual(await rpc["viewer.consent"]?.({}, context), { error: setupRequiredMessage });
    assert.match(setupRequiredMessage, /\/artiflow-setup/);
    assert.deepEqual(await rpc["associated.list"]?.({ sessionID: "s" }, context), []);
    assert.equal(calls.tools, 0);
    assert.equal(calls.skills, 0);
    await cleanup?.();
  });
});

test("a stored URL written in bootstrap mode is readable through the resolution chain", async () => {
  await withoutEnvironment(async () => {
    const { ctx, storage, commands, rpc, calls } = entry();
    await plugin.setup(ctx as never);
    const command = commands[0];
    assert.ok(command);
    await command.execute({ sessionID: "s", prompt: { text: "https://artiflow.example" } });
    assert.deepEqual([...storage.stored], [["url", "https://artiflow.example"]]);
    assert.equal(await resolvedInstanceUrl({ options: {}, env: undefined, storage }), "https://artiflow.example");
    assert.deepEqual(await rpc["config.url"]?.({}, { signal: new AbortController().signal }), {
      url: "https://artiflow.example",
    });
    assert.equal(calls.tools, 0);
  });
});

test("bootstrap mode has no fallback when nothing resolves and a configured value is invalid", async () => {
  const storage = memory();
  assert.equal(await optionalInstanceUrl({ options: {}, env: undefined, storage }), null);
  await assert.rejects(optionalInstanceUrl({ options: {}, env: undefined, storage: memory({ url: "nope" }) }), {
    message,
  });
  await withoutEnvironment(async () => {
    const { ctx } = entry({}, { url: "ftp://example.com" });
    await assert.rejects(async () => plugin.setup(ctx as never), { message });
  });
});

test("the setup command persists a normalized origin and reports how to apply it", async () => {
  const storage = memory();
  const command = setupCommand(storage, async () => {});
  await command.execute({ sessionID: "s", prompt: { text: "https://artiflow.example///" } });
  assert.deepEqual([...storage.stored], [["url", "https://artiflow.example"]]);
  const message = await setupMessage("  https://artiflow.example/  ", storage);
  assert.equal(message.ok, true);
  assert.match(message.message, /https:\/\/artiflow\.example/);
  assert.match(message.message, /reload or restart/i);
  assert.match(message.message, /server/i);
});

test("the setup command rejects an invalid origin without writing storage", async () => {
  for (const text of [
    "",
    "   ",
    "ftp://example.com",
    "https://example.com/path",
    "artiflow.example",
    "https://a.example/?x=1",
  ]) {
    const storage = memory();
    const reports: string[] = [];
    const command = setupCommand(storage, async (input) => {
      reports.push(input.text);
    });
    await command.execute({ sessionID: "s", prompt: { text } });
    assert.equal(storage.stored.size, 0);
    assert.equal(reports.length, 1);
    assert.match(reports[0] as string, /not saved/i);
    assert.doesNotMatch(reports[0] as string, /saved as/i);
  }
});

test("the setup command reports the persisted origin through the session output", async () => {
  await withoutEnvironment(async () => {
    const { ctx, storage, commands, reports } = entry();
    await storage.set("url", "https://old.example");
    await plugin.setup(ctx as never);
    const command = commands[0];
    assert.ok(command);
    await command.execute({ sessionID: "session-1", prompt: { text: "https://artiflow.example" } });
    assert.deepEqual([...storage.stored], [["url", "https://artiflow.example"]]);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.sessionID, "session-1");
    assert.match(reports[0]?.text ?? "", /https:\/\/artiflow\.example/);
    assert.match(reports[0]?.text ?? "", /reload or restart/i);
  });
});

test("the GUI prefers the URL resolved by the server chain", async () => {
  const reader = guiConfigReader({}, "https://env.example", async () => ({ url: "https://stored.example" }));
  assert.deepEqual(reader.current(), guiConfig({}, "https://env.example"));
  assert.deepEqual(await reader.refresh(), { base: "https://stored.example", error: null });
  assert.deepEqual(reader.current(), { base: "https://stored.example", error: null });
});

test("the GUI falls back to options and environment when the server reports no URL", async () => {
  const optionsFirst = guiConfigReader({ url: "https://option.example" }, "https://env.example", async () => ({
    url: null,
  }));
  assert.deepEqual(await optionsFirst.refresh(), { base: "https://option.example", error: null });
  const environment = guiConfigReader({}, "https://env.example", async () => ({ url: null }));
  assert.deepEqual(await environment.refresh(), { base: "https://env.example", error: null });
  const nothing = guiConfigReader({}, undefined, async () => ({ url: null }));
  const config = await nothing.refresh();
  assert.equal(config.base, null);
  assert.match(config.error ?? "", /artiflow-setup/);
});

test("the GUI keeps its local fallback while the server RPC is unavailable", async () => {
  const optionsFirst = guiConfigReader({ url: "https://option.example" }, undefined, async () => {
    throw new Error("rpc.unavailable");
  });
  assert.deepEqual(await optionsFirst.refresh(), { base: "https://option.example", error: null });
  const environment = guiConfigReader({}, "https://env.example", async () => {
    throw new Error("rpc.unavailable");
  });
  assert.deepEqual(await environment.refresh(), { base: "https://env.example", error: null });
});

test("the GUI picks up a URL provisioned after an empty server response and never keeps a stale null", async () => {
  let answer: { url: string | null } = { url: null };
  const reader = guiConfigReader({}, undefined, async () => answer);
  assert.equal((await reader.refresh()).base, null);
  answer = { url: "https://stored.example" };
  assert.deepEqual(await reader.refresh(), { base: "https://stored.example", error: null });
  assert.deepEqual(reader.current(), { base: "https://stored.example", error: null });
  answer = { url: null };
  assert.equal((await reader.refresh()).base, null);
});

test("the GUI rejects an invalid server URL instead of falling back", async () => {
  const reader = guiConfigReader({ url: "https://option.example" }, undefined, async () => ({
    url: "https://server.example/path",
  }));
  const config = await reader.refresh();
  assert.equal(config.base, null);
  assert.match(config.error ?? "", /absolute http\(s\) origin/);
});
