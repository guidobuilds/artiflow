const PSEUDO_DEVICES = new Set([
  "erspan0",
  "gre0",
  "gretap0",
  "ip6_vti0",
  "ip6erspan0",
  "ip6gre0",
  "ip6gretap0",
  "ip6tnl0",
  "ip_vti0",
  "sit0",
  "tunl0",
]);
const LOOPBACK_V6 = "00000000000000000000000000000001";
const LOOPBACK_V4_FIRST_OCTET = 127;

const parseDevices = (text) =>
  text
    .split("\n")
    .slice(2)
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name.length > 0)
    .sort();

const octets = (hex) => {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{8}$/.test(hex)) return null;
  const value = Number.parseInt(hex, 16);
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
};
const dotted = (bytes) => bytes.join(".");

const parseRoutes = (text) =>
  text
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [iface, destination, , , , , , mask] = line.split(/\s+/);
      return { iface: iface ?? "?", destination, mask };
    });

const parseAddresses = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [address = "", , , , , device] = line.split(/\s+/);
      return { address: address.toLowerCase(), device: device ?? "?" };
    });

export function isLoopbackOnly(procNetDev, procNetRoute, procNetIfInet6) {
  const devices = parseDevices(String(procNetDev ?? ""));
  const routes = parseRoutes(String(procNetRoute ?? ""));
  const addresses = parseAddresses(String(procNetIfInet6 ?? ""));
  const violations = [];

  if (!devices.includes("lo")) violations.push("loopback device lo is missing");
  for (const device of devices) {
    if (device !== "lo" && !PSEUDO_DEVICES.has(device)) violations.push(`unexpected network device ${device}`);
  }

  for (const route of routes) {
    const destination = octets(route.destination);
    const mask = octets(route.mask);
    if (destination === null || mask === null) {
      violations.push(`unreadable IPv4 route on ${route.iface}`);
      continue;
    }
    if (mask.every((byte) => byte === 0)) {
      violations.push(`default IPv4 route via ${route.iface}`);
      continue;
    }
    const network = destination.map((byte, index) => byte & mask[index]);
    if (network[0] !== LOOPBACK_V4_FIRST_OCTET) {
      violations.push(`non-loopback IPv4 route ${dotted(network)} via ${route.iface}`);
    }
  }

  for (const { address, device } of addresses) {
    if (address !== LOOPBACK_V6) violations.push(`non-loopback IPv6 address ${address} on ${device}`);
  }

  const detail =
    `devices ${devices.join(", ") || "none"}; ` +
    `${routes.length} IPv4 route(s); ${addresses.length} IPv6 address(es)`;
  return {
    isolated: violations.length === 0,
    reason: violations.length === 0 ? null : violations.join("; "),
    detail,
  };
}
