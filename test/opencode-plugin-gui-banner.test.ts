import assert from "node:assert/strict";
import test from "node:test";
import { bannerFor, type BannerInput } from "../plugins/opencode/src/gui-banner.ts";

const quiet: BannerInput = {
  consent: "idle",
  consentError: "",
  problem: "",
  sessionError: "",
  loadError: "",
  notFound: false,
  tokenUnavailable: false,
  authRequired: false,
  opened: true,
  ready: true,
  viewing: true,
};
const primary = (buttons: readonly { primary: boolean }[]) => buttons.filter((button) => button.primary);

test("a pending consent renders one busy waiting banner with a Cancel action", () => {
  const banner = bannerFor({ ...quiet, consent: "pending", ready: false, viewing: false });
  assert.deepEqual(banner, {
    text: "Waiting for consent in your browser…",
    role: "status",
    busy: true,
    buttons: [{ label: "Cancel", action: "cancel", primary: false }],
  });
});

test("a missing credential and a rejected viewer each ask for one sign-in action", () => {
  const missing = bannerFor({ ...quiet, tokenUnavailable: true, ready: false, viewing: false });
  const rejected = bannerFor({ ...quiet, authRequired: true, ready: false, viewing: false });
  assert.deepEqual(missing, {
    text: "No Artiflow credential for this viewer: sign in, then reload the artifact.",
    role: "status",
    busy: false,
    buttons: [{ label: "Sign in to Artiflow", action: "sign-in", primary: true }],
  });
  assert.deepEqual(rejected, {
    text: "Sign in to Artiflow to view this artifact.",
    role: "status",
    busy: false,
    buttons: [{ label: "Sign in to Artiflow", action: "sign-in", primary: true }],
  });
});

test("every error banner carries exactly one primary recovery button", () => {
  const errors: BannerInput[] = [
    { ...quiet, problem: 'Configure "url" in the Artiflow plugin options, or set ARTIFLOW_URL.' },
    { ...quiet, sessionError: "Unable to load associated artifacts." },
    { ...quiet, loadError: "Unable to open Artiflow viewer." },
    { ...quiet, notFound: true },
    { ...quiet, consent: "error", consentError: "Artiflow sign-in failed: denied" },
  ];
  for (const error of errors) {
    const banner = bannerFor({ ...error, ready: false, viewing: false });
    assert.ok(banner, `an error state renders a banner: ${JSON.stringify(error)}`);
    assert.equal(banner.role, "alert");
    assert.notEqual(banner.text, "");
    assert.equal(primary(banner.buttons).length, 1);
    assert.equal(banner.buttons.length, 1);
  }
});

test("retry states recover with Reload artifact and a failed sign-in retries with sign-in", () => {
  const notFound = bannerFor({ ...quiet, notFound: true, ready: false, viewing: false });
  assert.equal(notFound?.text, "This artifact does not exist (or was deleted) on the instance.");
  assert.deepEqual(notFound?.buttons, [{ label: "Reload artifact", action: "reload", primary: true }]);
  const consent = bannerFor({ ...quiet, consent: "error", consentError: "Artiflow sign-in failed: denied" });
  assert.equal(consent?.text, "Artiflow sign-in failed: denied");
  assert.deepEqual(consent?.buttons, [{ label: "Sign in to Artiflow", action: "sign-in", primary: true }]);
});

test("configuration and load failures take precedence over the sign-in prompt", () => {
  const banner = bannerFor({ ...quiet, problem: "Artiflow Desktop connection unavailable.", tokenUnavailable: true });
  assert.equal(banner?.text, "Artiflow Desktop connection unavailable.");
  assert.deepEqual(banner?.buttons, [{ label: "Reload artifact", action: "reload", primary: true }]);
});

test("loading has no action and a background view offers only Reload artifact", () => {
  assert.deepEqual(bannerFor({ ...quiet, opened: false, ready: false, viewing: false }), {
    text: "Loading artifact…",
    role: "status",
    busy: false,
    buttons: [],
  });
  assert.deepEqual(bannerFor({ ...quiet, viewing: false }), {
    text: "",
    role: "status",
    busy: false,
    buttons: [{ label: "Reload artifact", action: "reload", primary: true }],
  });
  assert.equal(bannerFor(quiet), undefined);
});
