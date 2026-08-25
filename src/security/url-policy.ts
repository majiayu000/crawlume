import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import ipaddr from "ipaddr.js";

import { ReadError } from "../errors.js";

export type AddressResolver = (hostname: string) => Promise<LookupAddress[]>;

const blockedHostnames = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data.ec2.internal",
]);
const dnsFakeIpRange = ipaddr.parseCIDR("198.18.0.0/15");

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return blockedHostnames.has(normalized) || normalized.endsWith(".localhost");
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export function isDnsFakeIpAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.kind() === "ipv4" && parsed.match(dnsFakeIpRange);
  } catch {
    return false;
  }
}

async function systemResolver(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export class UrlPolicy {
  private readonly resolver: AddressResolver;
  private readonly cache = new Map<string, { expiresAt: number; addresses: LookupAddress[] }>();

  constructor(
    resolver: AddressResolver = systemResolver,
    private readonly allowDnsFakeIp = false,
  ) {
    this.resolver = resolver;
  }

  isAllowedResolvedAddress(address: string): boolean {
    return isPublicAddress(address) || (this.allowDnsFakeIp && isDnsFakeIpAddress(address));
  }

  parse(input: string): URL {
    let url: URL;
    try {
      url = new URL(input);
    } catch (error) {
      throw new ReadError("INVALID_URL", "The URL is not valid.", { cause: error });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ReadError("INVALID_URL", "Only http and https URLs are supported.", {
        details: { protocol: url.protocol },
      });
    }
    if (url.username !== "" || url.password !== "") {
      throw new ReadError("INVALID_URL", "Credentials in URLs are not allowed.");
    }
    if (isBlockedHostname(url.hostname)) {
      throw new ReadError("SSRF_BLOCKED", "The target hostname is not publicly routable.", {
        details: { hostname: url.hostname },
      });
    }
    return url;
  }

  async assertPublic(url: URL): Promise<LookupAddress[]> {
    this.parse(url.toString());
    const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const literal = ipaddr.isValid(hostname) ? [{ address: hostname, family: 0 }] : null;
    const addresses = literal ?? (await this.resolve(url.hostname));
    const addressAllowed = literal === null
      ? (address: string): boolean => this.isAllowedResolvedAddress(address)
      : isPublicAddress;
    if (addresses.length === 0 || addresses.some(({ address }) => !addressAllowed(address))) {
      throw new ReadError("SSRF_BLOCKED", "The target resolves to a non-public address.", {
        details: { hostname: url.hostname },
      });
    }
    return addresses;
  }

  async resolve(hostname: string): Promise<LookupAddress[]> {
    const cached = this.cache.get(hostname);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.addresses;
    }
    let addresses: LookupAddress[];
    try {
      addresses = await this.resolver(hostname);
    } catch (error) {
      throw new ReadError("INVALID_URL", "The target hostname could not be resolved.", {
        details: { hostname },
        cause: error,
      });
    }
    this.cache.set(hostname, { expiresAt: Date.now() + 60_000, addresses });
    return addresses;
  }
}
