import { Schema } from "effect";
import { CloudError } from "./errors.js";

export const noStore = { "Cache-Control": "no-store" } as const;

export function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(value, { status, headers: { ...noStore, ...headers } });
}

export async function readBody(request: Pick<Request, "body">, limit: number) {
  if (!request.body) throw new CloudError("invalid_request", 400);
  const reader = request.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new CloudError("request_too_large", 413);
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function readJson(request: Pick<Request, "body">, limit: number): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBody(request, limit)));
  } catch (error) {
    if (error instanceof CloudError) throw error;
    throw new CloudError("invalid_request", 400);
  }
}

export function decode<T>(schema: Schema.Decoder<T>, value: unknown): T {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new CloudError("invalid_request", 400);
  }
}
