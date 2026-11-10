const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

// 128 random bits as 26 lowercase base32 characters. Valid as a protocol Identifier, a controller
// bearer id and a runner name suffix, and never shaped like a local operation UUID.
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return id + alphabet[(value << (5 - bits)) & 31];
}

export async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison of two equal-length hex digests.
export function sameDigest(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
