const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class MigrationTargetError extends Error {
  override name = "MigrationTargetError";
}

function refuse(message: string): never {
  throw new MigrationTargetError(`${message} No connection was opened.`);
}

export function assertMigrationTarget(connectionString: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    refuse("DATABASE_URL must be a valid postgres:// URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    refuse("DATABASE_URL must use the postgres:// protocol.");
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) return;
  if (!allowRemote) {
    refuse(
      "Refusing to migrate a non-loopback database. " +
        "Set ARTIFLOW_ALLOW_REMOTE_MIGRATE=1 explicitly to migrate the configured remote database.",
    );
  }
}
