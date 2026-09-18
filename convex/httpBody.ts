export async function readBody(request: Pick<Request, "body">, limit = 4096) {
  if (!request.body) throw new Error("Missing request body.");
  const reader = request.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit) throw new Error("Request body exceeds the size limit.");
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

export async function smallJson(request: Pick<Request, "body">, limit = 4096): Promise<unknown> {
  return JSON.parse(new TextDecoder().decode(await readBody(request, limit)));
}
