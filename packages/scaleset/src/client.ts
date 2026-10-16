import { Schema } from "effect";
import {
  Count,
  Identifier,
  ScaleSetProtocolError,
  Session,
  SessionId,
  decodeMessage,
} from "./messages.js";

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

const endpoint = "_apis/runtime/runnerscalesets";
const version = "6.0-preview";
const maxResponseBytes = 1024 * 1024;
const Acquired = Schema.Struct({ count: Count, value: Schema.Array(Identifier) });
const Label = Schema.Struct({
  name: Schema.NonEmptyString,
  type: Schema.optionalKey(Schema.String),
});
const ScaleSet = Schema.Struct({
  id: Identifier,
  name: Schema.NonEmptyString,
  runnerGroupId: Identifier,
  labels: Schema.Array(Label),
});
const ScaleSets = Schema.Struct({ count: Count, value: Schema.Array(ScaleSet) });
const Groups = Schema.Struct({
  count: Count,
  value: Schema.Array(
    Schema.Struct({
      id: Identifier,
      name: Schema.NonEmptyString,
      isDefaultGroup: Schema.Boolean,
    }),
  ),
});
const Jit = Schema.Struct({
  runner: Schema.Struct({ id: Identifier, name: Schema.NonEmptyString }),
  encodedJITConfig: Schema.NonEmptyString,
});

function decode<S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new ScaleSetProtocolError();
  }
}

export class ScaleSetHttpError extends Error {
  readonly queueTokenExpired;
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    queueRequest: boolean,
  ) {
    super(`Scale set request failed (${status}).`);
    this.name = "ScaleSetHttpError";
    this.queueTokenExpired = queueRequest && status === 401;
  }
}

function secureUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "Scale set endpoints must use HTTPS without embedded credentials or fragments.",
    );
  return url;
}

function serviceUrl(base: string, path: string, resource = endpoint) {
  const url = secureUrl(base);
  if (url.search) throw new Error("Actions service URL must not contain a query.");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${resource}${path ? `/${path}` : ""}`;
  url.searchParams.set("api-version", version);
  return url;
}

export async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ScaleSetProtocolError();
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) throw new ScaleSetProtocolError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new ScaleSetProtocolError();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

async function request(
  fetch: Fetch,
  url: URL,
  token: string,
  method: string,
  expected: number,
  signal: AbortSignal | undefined,
  queueRequest: boolean,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Scale set request timed out.", "TimeoutError")),
    70000,
  );
  const boundedSignal = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  try {
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: boundedSignal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "vectis-scaleset-spike/0.1",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      response.status !== expected &&
      !(queueRequest && method === "GET" && response.status === 202)
    ) {
      await response.body?.cancel();
      throw new ScaleSetHttpError(
        response.status,
        response.headers.get("Retry-After"),
        queueRequest,
      );
    }
    if (response.status === 202 || response.status === 204) {
      await response.body?.cancel();
      return undefined;
    }
    return await readJson(response);
  } catch (error) {
    boundedSignal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function decodeSession(input: unknown) {
  try {
    const session = Schema.decodeUnknownSync(Session)(input);
    secureUrl(session.messageQueueUrl);
    return session;
  } catch {
    throw new ScaleSetProtocolError();
  }
}

export class ScaleSetAdminClient {
  constructor(
    private readonly serviceBaseUrl: string,
    private readonly adminToken: string,
    private readonly fetch: Fetch,
  ) {}

  async defaultRunnerGroup(signal?: AbortSignal) {
    const url = serviceUrl(this.serviceBaseUrl, "", "_apis/runtime/runnergroups/");
    url.searchParams.set("groupName", "default");
    const groups = decode(
      Groups,
      await request(this.fetch, url, this.adminToken, "GET", 200, signal, false),
    );
    const group = groups.value[0];
    if (groups.count !== 1 || groups.value.length !== 1 || !group?.isDefaultGroup)
      throw new ScaleSetProtocolError();
    return group;
  }

  async findScaleSet(runnerGroupId: number, name: string, signal?: AbortSignal) {
    decode(Identifier, runnerGroupId);
    decode(Schema.NonEmptyString, name);
    const url = serviceUrl(this.serviceBaseUrl, "");
    url.searchParams.set("runnerGroupId", String(runnerGroupId));
    url.searchParams.set("name", name);
    const sets = decode(
      ScaleSets,
      await request(this.fetch, url, this.adminToken, "GET", 200, signal, false),
    );
    if (sets.count !== sets.value.length || sets.count > 1) throw new ScaleSetProtocolError();
    const set = sets.value[0];
    if (set && (set.name !== name || set.runnerGroupId !== runnerGroupId))
      throw new ScaleSetProtocolError();
    return set ?? null;
  }

  async getScaleSet(scaleSetId: number, signal?: AbortSignal) {
    decode(Identifier, scaleSetId);
    const set = decode(
      ScaleSet,
      await request(
        this.fetch,
        serviceUrl(this.serviceBaseUrl, String(scaleSetId)),
        this.adminToken,
        "GET",
        200,
        signal,
        false,
      ),
    );
    if (set.id !== scaleSetId) throw new ScaleSetProtocolError();
    return set;
  }

  async createScaleSet(
    runnerGroupId: number,
    name: string,
    labels: readonly string[],
    signal?: AbortSignal,
  ) {
    decode(Identifier, runnerGroupId);
    decode(Schema.NonEmptyString, name);
    decode(Schema.Array(Schema.NonEmptyString), labels);
    const set = decode(
      ScaleSet,
      await request(
        this.fetch,
        serviceUrl(this.serviceBaseUrl, ""),
        this.adminToken,
        "POST",
        200,
        signal,
        false,
        {
          name,
          runnerGroupId,
          labels: labels.map((name) => ({ name, type: "System" })),
          RunnerSetting: { disableUpdate: true },
        },
      ),
    );
    if (set.name !== name || set.runnerGroupId !== runnerGroupId) throw new ScaleSetProtocolError();
    return set;
  }

  async deleteScaleSet(scaleSetId: number, signal?: AbortSignal) {
    decode(Identifier, scaleSetId);
    await request(
      this.fetch,
      serviceUrl(this.serviceBaseUrl, String(scaleSetId)),
      this.adminToken,
      "DELETE",
      204,
      signal,
      false,
    );
  }

  async generateJitConfig(scaleSetId: number, runnerName: string, signal?: AbortSignal) {
    decode(Identifier, scaleSetId);
    decode(Schema.NonEmptyString, runnerName);
    const jit = decode(
      Jit,
      await request(
        this.fetch,
        serviceUrl(this.serviceBaseUrl, `${scaleSetId}/generatejitconfig`),
        this.adminToken,
        "POST",
        200,
        signal,
        false,
        { name: runnerName, workFolder: "_work" },
      ),
    );
    if (jit.runner.name !== runnerName) throw new ScaleSetProtocolError();
    return jit;
  }

  async createSession(scaleSetId: number, ownerName: string, signal?: AbortSignal) {
    Schema.decodeUnknownSync(Identifier)(scaleSetId);
    Schema.decodeUnknownSync(Schema.NonEmptyString)(ownerName);
    return decodeSession(
      await request(
        this.fetch,
        serviceUrl(this.serviceBaseUrl, `${scaleSetId}/sessions`),
        this.adminToken,
        "POST",
        200,
        signal,
        false,
        { ownerName },
      ),
    );
  }

  async refreshSession(scaleSetId: number, sessionId: string, signal?: AbortSignal) {
    return decodeSession(
      await request(
        this.fetch,
        this.sessionUrl(scaleSetId, sessionId),
        this.adminToken,
        "PATCH",
        200,
        signal,
        false,
      ),
    );
  }

  async deleteSession(scaleSetId: number, sessionId: string, signal?: AbortSignal) {
    await request(
      this.fetch,
      this.sessionUrl(scaleSetId, sessionId),
      this.adminToken,
      "DELETE",
      204,
      signal,
      false,
    );
  }

  private sessionUrl(scaleSetId: number, sessionId: string) {
    Schema.decodeUnknownSync(Identifier)(scaleSetId);
    Schema.decodeUnknownSync(SessionId)(sessionId);
    return serviceUrl(
      this.serviceBaseUrl,
      `${scaleSetId}/sessions/${encodeURIComponent(sessionId)}`,
    );
  }
}

export class ScaleSetSessionClient {
  private readonly session: Session;
  constructor(
    private readonly serviceBaseUrl: string,
    private readonly scaleSetId: number,
    session: Session,
    private readonly fetch: Fetch,
  ) {
    Schema.decodeUnknownSync(Identifier)(scaleSetId);
    this.session = decodeSession(session);
  }

  async getMessage(lastMessageId: number, maxCapacity: number, signal?: AbortSignal) {
    Schema.decodeUnknownSync(Count)(lastMessageId);
    Schema.decodeUnknownSync(Count)(maxCapacity);
    const url = secureUrl(this.session.messageQueueUrl);
    if (lastMessageId > 0) url.searchParams.set("lastMessageId", String(lastMessageId));
    const result = await request(
      this.fetch,
      url,
      this.session.messageQueueAccessToken,
      "GET",
      200,
      signal,
      true,
      undefined,
      {
        Accept: `application/json; api-version=${version}`,
        "X-ScaleSetMaxCapacity": String(maxCapacity),
      },
    );
    return result === undefined ? null : decodeMessage(result);
  }

  async acknowledgeMessage(messageId: number, signal?: AbortSignal) {
    Schema.decodeUnknownSync(Count)(messageId);
    const url = secureUrl(this.session.messageQueueUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${messageId}`;
    await request(
      this.fetch,
      url,
      this.session.messageQueueAccessToken,
      "DELETE",
      204,
      signal,
      true,
    );
  }

  async acquireJobs(requestIds: readonly number[], signal?: AbortSignal) {
    Schema.decodeUnknownSync(Schema.Array(Identifier))(requestIds);
    const result = await request(
      this.fetch,
      serviceUrl(this.serviceBaseUrl, `${this.scaleSetId}/acquirejobs`),
      this.session.messageQueueAccessToken,
      "POST",
      200,
      signal,
      true,
      requestIds,
    );
    try {
      const acquired = Schema.decodeUnknownSync(Acquired)(result);
      if (
        acquired.count !== acquired.value.length ||
        new Set(acquired.value).size !== acquired.value.length ||
        acquired.value.some((id) => !requestIds.includes(id))
      )
        throw new ScaleSetProtocolError();
      return acquired.value;
    } catch {
      throw new ScaleSetProtocolError();
    }
  }
}
