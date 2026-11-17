import type { ConsentStatus } from "./gui-auth.ts";

export type BannerAction = "sign-in" | "reload" | "cancel";

export interface BannerButton {
  readonly label: string;
  readonly action: BannerAction;
  readonly primary: boolean;
}

export interface Banner {
  readonly text: string;
  readonly role: "status" | "alert";
  readonly busy: boolean;
  readonly buttons: readonly BannerButton[];
}

export interface BannerInput {
  readonly consent: ConsentStatus;
  readonly consentError: string;
  readonly problem: string;
  readonly sessionError: string;
  readonly loadError: string;
  readonly notFound: boolean;
  readonly tokenUnavailable: boolean;
  readonly authRequired: boolean;
  readonly opened: boolean;
  readonly ready: boolean;
  readonly viewing: boolean;
}

const WAITING_CONSENT = "Waiting for consent in your browser…";
const LOADING = "Loading artifact…";
const NOT_FOUND = "This artifact does not exist (or was deleted) on the instance.";
const NO_CREDENTIAL = "No Artiflow credential for this viewer: sign in, then reload the artifact.";
const SIGN_IN_REQUIRED = "Sign in to Artiflow to view this artifact.";

const signIn: BannerButton = { label: "Sign in to Artiflow", action: "sign-in", primary: true };
const reload: BannerButton = { label: "Reload artifact", action: "reload", primary: true };
const cancel: BannerButton = { label: "Cancel", action: "cancel", primary: false };

const banner = (text: string, role: Banner["role"], busy: boolean, buttons: BannerButton[]): Banner => ({
  text,
  role,
  busy,
  buttons,
});

export function bannerFor(input: BannerInput): Banner | undefined {
  if (input.consent === "pending") return banner(WAITING_CONSENT, "status", true, [cancel]);
  if (input.consent === "error" && input.consentError) return banner(input.consentError, "alert", false, [signIn]);
  if (input.problem) return banner(input.problem, "alert", false, [reload]);
  if (input.sessionError) return banner(input.sessionError, "alert", false, [reload]);
  if (input.loadError) return banner(input.loadError, "alert", false, [reload]);
  if (input.notFound) return banner(NOT_FOUND, "alert", false, [reload]);
  if (input.tokenUnavailable) return banner(NO_CREDENTIAL, "status", false, [signIn]);
  if (input.authRequired) return banner(SIGN_IN_REQUIRED, "status", false, [signIn]);
  if (!input.opened || (!input.ready && !input.viewing)) return banner(LOADING, "status", false, []);
  if (input.viewing) return undefined;
  return banner("", "status", false, [reload]);
}
