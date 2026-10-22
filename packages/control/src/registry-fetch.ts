import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { HostError } from "@pluhub/sdk";
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
// BlockList treats IPv4 and IPv4-mapped IPv6 as equivalent. Reject mapped
// notation separately so its /96 range does not accidentally ban every IPv4.
export function validateRegistryAddresses(
  url: URL,
  addresses: { address: string; family: number }[],
  allowPrivateNetwork = false,
) {
  const loopback =
    addresses.length > 0 &&
    addresses.every((a) => a.address === "::1" || a.address.startsWith("127."));
  if (
    !addresses.length ||
    addresses.some(
      (a) => ![4, 6].includes(a.family) || isIP(a.address) !== a.family,
    ) ||
    (url.protocol !== "https:" && !(allowPrivateNetwork && loopback)) ||
    (!allowPrivateNetwork &&
      addresses.some(
        (a) =>
          (a.family === 6 &&
            new URL("http://[" + a.address + "]/").hostname
              .toLowerCase()
              .startsWith("[::ffff:")) ||
          blocked.check(a.address, a.family === 6 ? "ipv6" : "ipv4"),
      ))
  )
    throw new HostError(
      "registry_network",
      "Registry requires HTTPS and an allowed network address",
    );
}
export async function fetchRegistryBytes(
  url: URL,
  limit: number,
  allowPrivateNetwork = false,
  signal = AbortSignal.timeout(30000),
  redirects = 0,
): Promise<Buffer> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.username ||
    url.password ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new HostError("registry_url", "Invalid registry URL");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  validateRegistryAddresses(url, addresses, allowPrivateNetwork);
  const address = addresses[0]!;
  return new Promise<Buffer>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        headers: {
          accept: "application/json, application/gzip",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, options, callback) =>
          (options as any).all
            ? callback(
                null,
                addresses.map((a) => ({
                  address: a.address,
                  family: a.family,
                })),
              )
            : callback(null, address.address, address.family),
      },
      (response) => {
        if (
          [301, 302, 303, 307, 308].includes(response.statusCode ?? 0) &&
          response.headers.location
        ) {
          response.resume();
          if (redirects >= 3) {
            reject(
              new HostError("registry_redirect", "Too many registry redirects"),
            );
            return;
          }
          try {
            fetchRegistryBytes(
              new URL(response.headers.location, url),
              limit,
              allowPrivateNetwork,
              signal,
              redirects + 1,
            ).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new HostError(
              "registry_http",
              "Registry returned HTTP " + response.statusCode,
              502,
            ),
          );
          return;
        }
        if (Number(response.headers["content-length"] ?? 0) > limit) {
          response.destroy();
          reject(
            new HostError("registry_size", "Registry response is too large"),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit)
            response.destroy(
              new HostError("registry_size", "Registry response is too large"),
            );
          else chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    request.on("error", (error) =>
      reject(
        error instanceof HostError
          ? error
          : new HostError("registry_fetch", "Registry download failed", 502),
      ),
    );
    request.end();
  });
}
