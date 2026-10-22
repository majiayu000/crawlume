// Preloaded into E2E MCP processes so controlled example.com hosts resolve without public DNS.
// Requests still reach the controlled site through the test proxy; the address only has to be public.
import dnsPromises from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";

const controlledAddress = "93.184.215.14";
const originalLookup = dnsPromises.lookup;

function controlled(hostname) {
  return hostname === "example.com" || hostname.endsWith(".example.com");
}

dnsPromises.lookup = async (hostname, options) => {
  if (!controlled(hostname)) return originalLookup(hostname, options);
  const entry = { address: controlledAddress, family: 4 };
  return typeof options === "object" && options !== null && options.all === true ? [entry] : entry;
};
syncBuiltinESMExports();
