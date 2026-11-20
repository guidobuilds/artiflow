import type { Database } from "./adapters/postgres/db/client.ts";
import {
  createAuth,
  createAuthFromSnapshot,
  type AuthConfig,
  type AuthInstance,
} from "./auth.ts";
import { environmentSnapshot, readAccessSnapshot, type AccessSnapshot } from "./settings/access-snapshot.ts";
import { ACCESS_METHODS_KEY, readSettingRevision } from "./settings/store.ts";

const UNRESOLVED = "unresolved";

type StoredRevision = number | null | typeof UNRESOLVED;

type AuthState = {
  revision: number | null;
  snapshot: AccessSnapshot;
  instance: AuthInstance;
};

export type AuthHolder = {
  auth: AuthInstance;
  resolve: () => Promise<AuthInstance>;
  snapshot: () => Promise<AccessSnapshot>;
  builds: () => number;
};

function rank(revision: StoredRevision): number {
  if (revision === UNRESOLVED) return -1;
  if (revision === null) return 0;
  return revision;
}

function createFacade(resolveInstance: () => Promise<AuthInstance>, current: () => AuthInstance): AuthInstance {
  const api = new Proxy({} as AuthInstance["api"], {
    get(_target, property) {
      return async (...args: unknown[]) => {
        const instance = await resolveInstance();
        const member = Reflect.get(instance.api, property) as unknown;
        return typeof member === "function" ? Reflect.apply(member, instance.api, args) : member;
      };
    },
  });

  return {
    handler: (request: Request) => resolveInstance().then((instance) => instance.handler(request)),
    fetch: (request: Request) => resolveInstance().then((instance) => instance.fetch(request)),
    api,
    get options() {
      return current().options;
    },
    get $ERROR_CODES() {
      return current().$ERROR_CODES;
    },
    get $context() {
      return resolveInstance().then((instance) => instance.$context);
    },
    $Infer: {} as AuthInstance["$Infer"],
  };
}

export function createAuthHolder(input: { config: AuthConfig; database: Database }): AuthHolder {
  const { config, database } = input;
  const environment = environmentSnapshot(config.authProviders);
  let state: { revision: StoredRevision; snapshot: AccessSnapshot; instance: AuthInstance } = {
    revision: UNRESOLVED,
    snapshot: environment,
    instance: createAuth(config, database),
  };
  let builds = 1;
  let pending: { revision: number | null; promise: Promise<AuthState> } | null = null;

  async function storedRevision(): Promise<StoredRevision> {
    try {
      return await readSettingRevision(database.db, ACCESS_METHODS_KEY);
    } catch {
      return UNRESOLVED;
    }
  }

  async function build(): Promise<AuthState> {
    const read = await readAccessSnapshot({
      db: database.db,
      key: config.secretEncryptionKey ?? null,
      fallback: environment,
    });
    const instance = createAuthFromSnapshot(config, database, read.snapshot);
    builds += 1;
    return { revision: read.revision, snapshot: read.snapshot, instance };
  }

  async function resolve(): Promise<AuthInstance> {
    const revision = await storedRevision();
    if (revision === UNRESOLVED) return state.instance;
    if (state.revision === revision) return state.instance;

    let inFlight = pending;
    if (inFlight === null || inFlight.revision !== revision) {
      inFlight = { revision, promise: build() };
      pending = inFlight;
    }

    let next: AuthState;
    try {
      next = await inFlight.promise;
    } catch {
      return state.instance;
    } finally {
      if (pending === inFlight) pending = null;
    }

    if (rank(next.revision) >= rank(state.revision)) state = next;
    return state.instance;
  }

  async function snapshot(): Promise<AccessSnapshot> {
    await resolve();
    return state.snapshot;
  }

  return {
    auth: createFacade(resolve, () => state.instance),
    resolve,
    snapshot,
    builds: () => builds,
  };
}
