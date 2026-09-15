export async function verifyWebhook(
  secret: string,
  body: Uint8Array<ArrayBuffer>,
  signature: string | null,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(signature.slice(7 + index * 2, 9 + index * 2), 16);
  return crypto.subtle.verify("HMAC", key, bytes, body);
}
