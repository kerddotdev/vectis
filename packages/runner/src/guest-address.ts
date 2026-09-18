import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { VectisError } from "../../protocol/src/index.js";

function canonicalMac(value: string) {
  const parts = value.toLowerCase().split(":");
  if (parts.length !== 6 || parts.some((part) => !/^[0-9a-f]{1,2}$/.test(part))) return undefined;
  return parts.map((part) => part.padStart(2, "0")).join(":");
}

export function addressFromLeases(source: string, macAddress: string) {
  const target = canonicalMac(macAddress);
  if (!target)
    throw new VectisError("invalid_guest_address", "The VM network identity is invalid.");
  const matches = new Set<string>();
  for (const block of source.matchAll(/\{([^{}]*)\}/g)) {
    const body = block[1] ?? "";
    const hardware = body.match(/^\s*hw_address=1,([^\s]+)\s*$/m)?.[1];
    const address = body.match(/^\s*ip_address=([^\s]+)\s*$/m)?.[1];
    if (hardware && canonicalMac(hardware) === target && address && isIPv4(address))
      matches.add(address);
  }
  if (matches.size > 1)
    throw new VectisError(
      "ambiguous_guest_address",
      "Multiple addresses match this VM.",
      "Wait for DHCP state to settle before retrying guest control.",
    );
  return matches.values().next().value;
}

export function addressFromNeighbors(source: string, macAddress: string) {
  const target = canonicalMac(macAddress);
  if (!target)
    throw new VectisError("invalid_guest_address", "The VM network identity is invalid.");
  const matches = new Set<string>();
  for (const line of source.split("\n")) {
    const match = line.match(/^\S+ \(([^)]+)\) at ([^ ]+) on ([^ ]+)/);
    const [, address, mac, network] = match ?? [];
    if (
      address &&
      mac &&
      network?.startsWith("bridge") &&
      isIPv4(address) &&
      canonicalMac(mac) === target
    )
      matches.add(address);
  }
  if (matches.size > 1)
    throw new VectisError("ambiguous_guest_address", "Multiple addresses match this VM.");
  return matches.values().next().value;
}

const inspectNeighbors = promisify(execFile);

export async function waitForGuestAddress(macAddress: string, signal: AbortSignal) {
  while (!signal.aborted) {
    let contents: string;
    try {
      contents = await readFile("/var/db/dhcpd_leases", "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new VectisError("guest_address_unavailable", "macOS DHCP state could not be read.");
      contents = "";
    }
    if (contents.length > 1048576)
      throw new VectisError(
        "guest_address_unavailable",
        "macOS DHCP state exceeds the inspection limit.",
      );
    const address = addressFromLeases(contents, macAddress);
    if (address) return address;
    const neighbors = await inspectNeighbors("/usr/sbin/arp", ["-an"], {
      signal,
      timeout: 3000,
      maxBuffer: 1048576,
    }).catch(() => undefined);
    signal.throwIfAborted();
    const neighbor = neighbors && addressFromNeighbors(neighbors.stdout, macAddress);
    if (neighbor) return neighbor;
    await delay(500, undefined, { signal });
  }
  signal.throwIfAborted();
  throw new VectisError("guest_address_unavailable", "No guest address was observed.");
}
