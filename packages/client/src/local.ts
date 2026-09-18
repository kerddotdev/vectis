import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { Connection, VectisError } from "../../protocol/src/index.js";
import { VectisClient } from "./index.js";

export async function localClient(home: string): Promise<VectisClient> {
  try {
    const connection = Schema.decodeUnknownSync(Connection)(
      JSON.parse(await readFile(join(home, "connection.json"), "utf8")),
    );
    return new VectisClient(connection);
  } catch {
    throw new VectisError(
      "service_unavailable",
      "The local service connection is unavailable.",
      "Start the service with vectis service start using the same --home directory.",
    );
  }
}
