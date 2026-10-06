/**
 * Whether a URL a user typed points somewhere on the public internet.
 *
 * This exists because the agent runtime makes these requests *from inside our
 * network*. A URL naming `localhost`, a private range or a cloud metadata endpoint
 * turns the agent into a proxy for reaching things the user could not reach
 * themselves — server-side request forgery, with the app's own network position.
 *
 * The previous version of this check compared the hostname against a handful of
 * dotted-quad prefixes, which is the standard way for an SSRF blocklist to be wrong.
 * Three classes of bypass it missed:
 *
 *   - **Alternative IPv4 encodings.** `http://2130706433/`, `http://0x7f000001/` and
 *     `http://0177.0.0.1/` are all 127.0.0.1 to a resolver, and none of them start
 *     with the characters `127.`. `WHATWG`-conformant parsers normalise most of these
 *     in `new URL()`, but not all runtimes do, so the numeric forms are decoded here
 *     rather than trusted to be normalised.
 *   - **IPv6.** Only `::1` was caught. Unique-local (`fc00::/7`), link-local
 *     (`fe80::/10`) and IPv4-mapped (`::ffff:127.0.0.1`) all passed.
 *   - **Single-label hostnames.** In a container or on Kubernetes,
 *     `https://vault` or `https://kube-apiserver` resolves to an internal service and
 *     contains none of the blocked suffixes.
 *
 * What this still cannot do: stop DNS rebinding. The check runs on a string, and the
 * name is resolved later by whoever makes the request, so a hostname that answers
 * with a public address now and 127.0.0.1 a second later defeats it. That is not
 * fixable here — the structural answer is an egress network that cannot route to
 * internal ranges, and a deployment handling untrusted MCP URLs should have one.
 * This module raises the floor; it is not the ceiling.
 */

/** Why a URL was refused, phrased for the person who typed it. */
export type UrlRejection =
  | "invalid"
  | "scheme"
  | "credentials"
  | "private-address"
  | "single-label";

export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: UrlRejection,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/**
 * Reads an IPv4 literal in any of the forms a resolver accepts.
 *
 * Returns the four octets, or null when the string is not an IPv4 literal at all.
 * Handles dotted-decimal, dotted-octal (`0177.0.0.1`), dotted-hex (`0x7f.0.0.1`),
 * and the collapsed forms — `2130706433`, `0x7f000001`, `127.1` — all of which
 * `inet_aton` and therefore most resolvers accept.
 */
export function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;

  const values: number[] = [];

  for (const part of parts) {
    if (part === "") return null;

    let value: number;

    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      value = Number.parseInt(part, 10);
    } else {
      return null;
    }

    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }

  // The last part absorbs the remaining octets: `127.1` is 127.0.0.1, and a bare
  // `2130706433` is the whole address.
  const last = values.pop();
  if (last === undefined) return null;

  const maxLast = 256 ** (4 - values.length);
  if (last >= maxLast) return null;
  if (values.some((value) => value > 255)) return null;

  const octets = [...values];
  const remaining = 4 - values.length;
  for (let i = remaining - 1; i >= 0; i--) {
    octets.push((last >>> (8 * i)) & 0xff);
  }

  return octets;
}

/** Ranges that are never a legitimate destination for a user-supplied URL. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;

  return (
    a === 0 || // 0.0.0.0/8, including the "this host" address
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC6598 CGNAT, used by EKS/Fargate
    (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * Expands an IPv6 literal to its sixteen bytes, or null if it is not one.
 *
 * Deliberately a real expansion rather than a prefix match on the text: `fd00::1`,
 * `FD00:0:0:0:0:0:0:1` and `[fd00::1]` are the same address, and a string comparison
 * catches at most one of them.
 */
export function parseIpv6(host: string): number[] | null {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // A zone index (`fe80::1%eth0`) is not part of the address.
  text = text.split("%")[0] ?? text;

  if (!text.includes(":")) return null;

  const [headText = "", tailText, ...rest] = text.split("::");
  if (rest.length > 0) return null;

  const toGroups = (value: string): number[] | null => {
    if (value === "") return [];
    const groups: number[] = [];

    for (const group of value.split(":")) {
      // A trailing IPv4 part, as in `::ffff:127.0.0.1`.
      if (group.includes(".")) {
        const octets = parseIpv4(group);
        if (!octets || octets.length !== 4) return null;
        groups.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
        continue;
      }

      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }

    return groups;
  };

  const head = toGroups(headText);
  const tail = tailText === undefined ? [] : toGroups(tailText);
  if (!head || !tail) return null;

  if (tailText === undefined) {
    // No `::`, so it must be fully written out.
    if (head.length !== 8) return null;
    return head.flatMap((group) => [group >> 8, group & 0xff]);
  }

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;

  const groups = [...head, ...Array<number>(fill).fill(0), ...tail];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function isPrivateIpv6(bytes: number[]): boolean {
  const [b0 = 0, b1 = 0] = bytes;

  // ::  and ::1
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return true;
  }

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded address.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (mapped) return isPrivateIpv4(bytes.slice(12));

  // fc00::/7 unique local
  if ((b0 & 0xfe) === 0xfc) return true;
  // fe80::/10 link local
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  // ff00::/8 multicast
  if (b0 === 0xff) return true;
  // 64:ff9b::/96 NAT64, which translates to an IPv4 destination
  if (b0 === 0x00 && b1 === 0x64) return true;

  return false;
}

/** Hostnames that name an internal service by convention rather than by address. */
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".internal",
  ".local",
  ".localdomain",
  ".home.arpa",
  // Kubernetes in-cluster DNS
  ".cluster.local",
  ".svc",
];

const BLOCKED_HOSTS = new Set([
  "localhost",
  // Cloud metadata services, which hand out credentials to whoever asks.
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

/**
 * Validates a user-supplied URL and returns its canonical form.
 *
 * @param value the raw string a user entered
 * @param options.allowedProtocols defaults to https only. Auth headers travel with
 *   MCP requests, so plaintext is refused there; a caller with no credential to leak
 *   can widen it.
 */
export function assertPublicUrl(
  value: string,
  options: { allowedProtocols?: readonly string[] } = {},
): string {
  const allowed = options.allowedProtocols ?? ["https:"];

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new UnsafeUrlError("invalid", "That is not a valid URL.");
  }

  if (!allowed.includes(url.protocol)) {
    throw new UnsafeUrlError(
      "scheme",
      allowed.length === 1 && allowed[0] === "https:"
        ? "The URL must use https, since auth headers travel with every request."
        : `The URL must use one of: ${allowed.join(", ")}`,
    );
  }

  // `https://real-host@internal/` is read by some clients as a request to
  // `internal`. Nothing legitimate puts credentials in a URL we store.
  if (url.username || url.password) {
    throw new UnsafeUrlError(
      "credentials",
      "Put credentials in an auth header, not in the URL.",
    );
  }

  const host = url.hostname.toLowerCase();

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (isPrivateIpv4(ipv4)) {
      throw new UnsafeUrlError(
        "private-address",
        "That address is inside the server's own network, which is not allowed.",
      );
    }
  } else {
    const ipv6 = parseIpv6(host);
    if (ipv6) {
      if (isPrivateIpv6(ipv6)) {
        throw new UnsafeUrlError(
          "private-address",
          "That address is inside the server's own network, which is not allowed.",
        );
      }
    } else {
      // A name, not an address.
      if (
        BLOCKED_HOSTS.has(host) ||
        BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
      ) {
        throw new UnsafeUrlError(
          "private-address",
          "That address is inside the server's own network, which is not allowed.",
        );
      }

      // A hostname with no dot is only resolvable through a search domain or an
      // internal resolver, so on a public network it cannot be what the user meant.
      // This is what stops `https://vault` or `https://kube-apiserver`.
      if (!host.includes(".")) {
        throw new UnsafeUrlError(
          "single-label",
          "Use a fully qualified host name, e.g. mcp.example.com.",
        );
      }
    }
  }

  return url.toString();
}
