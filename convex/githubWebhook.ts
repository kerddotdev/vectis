import { GitHubJob } from "../packages/github/src/job.js";
import { Schema } from "effect";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { verifyWebhook } from "../packages/github/src/webhook.js";
import { readBody } from "./httpBody.js";
const Payload = Schema.Struct({
  action: Schema.optional(Schema.String),
  installation: Schema.optional(Schema.Struct({ id: Schema.Int })),
  repository: Schema.optional(Schema.Struct({ id: Schema.Int })),
  workflow_job: Schema.optional(GitHubJob),
});
export const receive = httpAction(async (ctx, request) => {
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (
    !event ||
    !["ping", "workflow_job", "installation", "installation_repositories", "repository"].includes(
      event,
    ) ||
    !deliveryId ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(deliveryId)
  )
    return new Response("Invalid delivery", { status: 400 });
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await readBody(request, 1024 * 1024);
  } catch {
    return new Response("Payload too large", { status: 413 });
  }
  const secret = await ctx.runQuery(internal.githubAppSetup.webhookSecret, {});
  if (!secret) return new Response("App setup is incomplete", { status: 503 });
  if (!(await verifyWebhook(secret, body, request.headers.get("x-hub-signature-256"))))
    return new Response("Invalid signature", { status: 401 });
  if (event === "ping") return Response.json({ accepted: true });
  let payload: typeof Payload.Type;
  try {
    payload = Schema.decodeUnknownSync(Payload)(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  const result = await ctx.runMutation(internal.githubDeliveries.accept, {
    deliveryId,
    event,
    ...(payload.action === undefined ? {} : { action: payload.action }),
    ...(payload.repository ? { repositoryId: payload.repository.id } : {}),
    ...(payload.installation ? { installationId: payload.installation.id } : {}),
    ...(payload.workflow_job
      ? {
          jobId: payload.workflow_job.id,
          job: { ...payload.workflow_job, labels: [...payload.workflow_job.labels] },
        }
      : {}),
  });
  return Response.json({ accepted: true, ...result }, { status: 202 });
});
