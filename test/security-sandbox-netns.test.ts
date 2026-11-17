import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

type NetnsVerdict = { isolated: boolean; reason: string | null; detail: string };

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const predicateUrl = pathToFileURL(path.join(repositoryRoot, "docker/security-sandbox/netns.mjs")).href;
const { isLoopbackOnly } = (await import(predicateUrl)) as {
  isLoopbackOnly: (procNetDev: string, procNetRoute: string, procNetIfInet6: string) => NetnsVerdict;
};

const PSEUDO_DEVICES = [
  "erspan0",
  "gre0",
  "gretap0",
  "ip6_vti0",
  "ip6gre0",
  "ip6tnl0",
  "ip_vti0",
  "lo",
  "sit0",
  "tunl0",
];

const procNetDev = (names: string[]): string =>
  [
    "Inter-|   Receive                                                |  Transmit",
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
    ...names.map((name) => `    ${name}:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0`),
  ].join("\n") + "\n";
const ROUTE_HEADER =
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
const procNetRoute = (rows: string[] = []): string => [ROUTE_HEADER, ...rows].join("\n") + "\n";
const procNetIfInet6 = (rows: string[]): string => rows.join("\n") + "\n";
const LOOPBACK_V6 = "00000000000000000000000000000001 01 80 10 80       lo";
const LINK_LOCAL_V6 = "fe800000000000000000000000000001 02 40 20 80    tunl0";
const DEFAULT_ROUTE_V4 = "sit0\t00000000\t00000000\t0003\t0\t0\t0\t00000000\t0\t0\t0";

test("pseudo tunnels next to lo are accepted: routes and addresses stay loopback", () => {
  const verdict = isLoopbackOnly(procNetDev(PSEUDO_DEVICES), procNetRoute(), procNetIfInet6([LOOPBACK_V6]));
  assert.equal(verdict.isolated, true, `expected acceptance, got: ${verdict.reason}`);
  assert.equal(verdict.reason, null);
  assert.match(verdict.detail, /lo/);
});

test("an extra real network device is rejected", () => {
  const verdict = isLoopbackOnly(procNetDev([...PSEUDO_DEVICES, "eth0"]), procNetRoute(), procNetIfInet6([LOOPBACK_V6]));
  assert.equal(verdict.isolated, false, "a routable interface must never pass");
  assert.match(String(verdict.reason), /unexpected network device eth0/);
});

test("a default route is rejected", () => {
  const verdict = isLoopbackOnly(procNetDev(PSEUDO_DEVICES), procNetRoute([DEFAULT_ROUTE_V4]), procNetIfInet6([LOOPBACK_V6]));
  assert.equal(verdict.isolated, false, "a default route means the namespace is not isolated");
  assert.match(String(verdict.reason), /default IPv4 route/);
});

test("a non-loopback IPv6 address is rejected", () => {
  const verdict = isLoopbackOnly(procNetDev(PSEUDO_DEVICES), procNetRoute(), procNetIfInet6([LOOPBACK_V6, LINK_LOCAL_V6]));
  assert.equal(verdict.isolated, false, "a routable IPv6 address must never pass");
  assert.match(String(verdict.reason), /non-loopback IPv6 address/);
});

test("bootstrap delegates the namespace verdict to this predicate", async () => {
  const source = await readFile(path.join(repositoryRoot, "docker/security-sandbox/bootstrap.mjs"), "utf8");
  assert.match(source, /from "\.\/netns\.mjs"/, "bootstrap must import the shared predicate");
  assert.doesNotMatch(source, /interfaces\.length\s*===\s*1/, "bootstrap must not count interfaces again");
});
