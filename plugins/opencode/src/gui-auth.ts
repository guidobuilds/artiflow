import { guiViewUrl } from "./gui-core.ts";

export type ConsentStatus = "idle" | "pending" | "authenticated" | "error";

export interface ConsentSnapshot {
  readonly status: ConsentStatus;
  readonly message: string;
}

export type ConsentRequest = (options: { signal: AbortSignal }) => Promise<{ token: string } | { error: string }>;

export class ConsentFlow {
  private status: ConsentStatus = "idle";
  private message = "";
  private attempt: AbortController | undefined;
  private readonly request: ConsentRequest;
  private readonly reload: () => void | Promise<void>;
  private readonly changed: (snapshot: ConsentSnapshot) => void;
  constructor(
    request: ConsentRequest,
    reload: () => void | Promise<void>,
    changed: (snapshot: ConsentSnapshot) => void = () => {},
  ) {
    this.request = request;
    this.reload = reload;
    this.changed = changed;
  }
  snapshot(): ConsentSnapshot {
    return { status: this.status, message: this.message };
  }
  async signIn(): Promise<void> {
    if (this.status === "pending") return;
    const attempt = new AbortController();
    this.attempt = attempt;
    this.publish("pending", "");
    try {
      const result = await this.request({ signal: attempt.signal });
      if (this.attempt !== attempt) return;
      this.attempt = undefined;
      if ("error" in result) {
        this.publish("error", `Artiflow sign-in failed: ${result.error}`);
        return;
      }
      this.publish("authenticated", "");
    } catch {
      if (this.attempt !== attempt) return;
      this.attempt = undefined;
      this.publish("error", "Unable to open Artiflow sign-in.");
      return;
    }
    try {
      await this.reload();
    } catch {
    }
  }
  cancel(): void {
    if (this.status !== "pending") return;
    this.reset();
  }
  reset(): void {
    this.attempt?.abort();
    this.attempt = undefined;
    this.publish("idle", "");
  }
  dispose(): void {
    this.attempt?.abort();
    this.attempt = undefined;
    this.status = "idle";
    this.message = "";
  }
  private publish(status: ConsentStatus, message: string): void {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.changed({ status, message });
  }
}

export function viewerHeaders(token: string | null): string | undefined {
  if (token === null) return;
  if (!token || /[\r\n]/.test(token)) throw new Error("Invalid Artiflow viewer token");
  return `Authorization: Bearer ${token}`;
}

export class ViewerAuth {
  readonly artifactUrl: string;
  private authRequired: boolean;
  private notFound = false;
  private ready = false;
  private viewing = false;
  private signingIn = false;
  private readonly base: string;
  private accessToken: string | null | undefined;
  private tokenUnavailable: boolean;
  constructor(base: string, artifactId: string, token?: string | null) {
    this.base = base;
    this.artifactUrl = `${guiViewUrl(base, artifactId)}?embed=1`;
    this.accessToken = token;
    this.authRequired = token === null;
    this.tokenUnavailable = token === null;
  }
  snapshot(id: string) {
    return {
      id,
      authRequired: this.authRequired,
      notFound: this.notFound,
      ready: this.ready,
      viewing: this.viewing,
      tokenUnavailable: this.tokenUnavailable,
    };
  }
  beginNavigation(): void {
    this.ready = false;
  }
  isSigningIn(): boolean {
    return this.signingIn;
  }
  token(): string | null {
    return this.accessToken ?? null;
  }
  reset(token: string | null): void {
    this.accessToken = token;
    this.authRequired = token === null;
    this.tokenUnavailable = token === null;
    this.ready = false;
    this.notFound = false;
    this.viewing = false;
    this.signingIn = false;
  }
  signIn(): string {
    this.ready = false;
    this.authRequired = false;
    this.notFound = false;
    this.signingIn = true;
    const artifact = new URL(this.artifactUrl);
    return `${this.base}/login?return=${encodeURIComponent(artifact.pathname + artifact.search)}`;
  }
  navigate(url: string, status: number): string | undefined {
    const current = new URL(url);
    const success = status >= 200 && status < 400;
    this.ready = false;
    if (current.origin !== this.base) {
      this.ready = this.signingIn && success;
      this.viewing = false;
      return;
    }
    const login = current.pathname === "/login";
    this.notFound = status === 404;
    if (status === 401 || (login && !this.signingIn)) {
      this.authRequired = true;
      this.signingIn = false;
      this.viewing = false;
      return;
    }
    if (this.signingIn && !login && success && !current.pathname.startsWith("/api/")) {
      this.signingIn = false;
      this.authRequired = false;
      if (url !== this.artifactUrl) return this.artifactUrl;
    }
    const artifact = current.pathname === new URL(this.artifactUrl).pathname;
    if (artifact && success) {
      this.authRequired = false;
      this.tokenUnavailable = false;
    }
    this.viewing = artifact && success;
    this.ready = success && !this.authRequired;
  }
}
