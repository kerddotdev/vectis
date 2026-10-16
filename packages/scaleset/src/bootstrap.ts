import { Schema } from "effect";
import { readJson, type Fetch } from "./client.js";
import { ScaleSetProtocolError } from "./messages.js";

const Token = Schema.Struct({ token: Schema.NonEmptyString });
const Connection = Schema.Struct({ url: Schema.NonEmptyString, token: Schema.NonEmptyString });
const Exp = Schema.Struct({ exp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });

export function tokenExpiration(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Schema.decodeUnknownSync(Exp)(value).exp;
  } catch {
    return null;
  }
}

export class ScaleSetBootstrapHttpError extends Error {
  constructor(
    readonly stage: "registration-token" | "runner-registration",
    readonly status: number,
  ) {
    super(`Scale set bootstrap ${stage} failed (${status}).`);
    this.name = "ScaleSetBootstrapHttpError";
  }
}

export async function bootstrapAdmin(
  input: { owner: string; repo: string; installationToken: string },
  fetch: Fetch,
  signal?: AbortSignal,
) {
  if (
    !/^[A-Za-z0-9-]+$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(input.repo) ||
    [".", ".."].includes(input.repo)
  )
    throw new Error("Invalid repository name.");
  async function post(
    path: string,
    authorization: string,
    stage: "registration-token" | "runner-registration",
    body?: unknown,
  ) {
    const boundedSignal = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(signal ? [signal] : []),
    ]);
    boundedSignal.throwIfAborted();
    const response = await fetch(new URL(`https://api.github.com${path}`), {
      method: "POST",
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: authorization,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "User-Agent": "vectis-scaleset-probe/0.1",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const expected = stage === "registration-token" ? 201 : 200;
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new ScaleSetBootstrapHttpError(stage, response.status);
    }
    return readJson(response);
  }
  try {
    const registration = Schema.decodeUnknownSync(Token)(
      await post(
        `/repos/${input.owner}/${input.repo}/actions/runners/registration-token`,
        `Bearer ${input.installationToken}`,
        "registration-token",
      ),
    );
    const connection = Schema.decodeUnknownSync(Connection)(
      await post(
        "/actions/runner-registration",
        `RemoteAuth ${registration.token}`,
        "runner-registration",
        { url: `https://github.com/${input.owner}/${input.repo}`, runner_event: "register" },
      ),
    );
    const url = new URL(connection.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new ScaleSetProtocolError();
    return {
      serviceUrl: url.href,
      adminToken: connection.token,
      adminTokenExp: tokenExpiration(connection.token),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ScaleSetBootstrapHttpError || error instanceof ScaleSetProtocolError)
      throw error;
    throw new ScaleSetProtocolError();
  }
}
