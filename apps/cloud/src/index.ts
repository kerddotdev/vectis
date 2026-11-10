import {
  HumanApi,
  MachineApi,
  type HumanPath,
  type MachinePath,
} from "../../../packages/protocol/src/cloud.js";
import type { Env } from "./env.js";
import { CloudError } from "./errors.js";
import { decode, json, readJson } from "./http.js";
import type { Context, HumanHandler, MachineHandler, RawHandler } from "./context.js";
import { authenticateMachine, bearerCredential, socketCredential } from "./auth/machine.js";
import { authenticateHuman } from "./auth/human.js";
import { hubFor } from "./notify.js";
import { runCron } from "./cron.js";
import { sync } from "./sync.js";
import { acknowledge } from "./operations.js";
import { respond } from "./inspections.js";
import { removeMachine } from "./machines.js";
import { approvePairing, machinePairing } from "./pairings.js";
import {
  approveController,
  controllerPairing,
  controllerRequest,
  revokeController,
} from "./controllers.js";
import { clerkWebhook, overview, removeAccount } from "./account.js";
import {
  discardLink,
  machineGitHubAccounts,
  oauthBegin,
  oauthCallback,
  oauthConfirm,
  unlinkAccount,
} from "./github/oauth.js";
import { appSetup, manifestCallback } from "./github/setup.js";
import {
  connectRepository,
  disableRepository,
  disconnectRepository,
  enableRepository,
  repositoryReadiness,
  setAccess,
  setAutomatic,
  setCacheVolume,
  setCapacityMode,
  setInfraRerun,
} from "./github/repositories.js";
import { githubWebhook } from "./github/webhook.js";
import { jobLogs, listJobs, refreshJob, scanJobs } from "./github/jobs.js";
import { controlRun } from "./github/runs.js";
import { analyzeMigration, publishMigration } from "./github/migrations.js";
import { prepareRunner, reconcileRunner, releaseRunner, runnerStatus } from "./runners/leases.js";
import { closeScaleSet, openScaleSet, refreshScaleSet } from "./runners/scale-sets.js";

export { MachineHub } from "./hub.js";

const machineRoutes: { [P in MachinePath]: MachineHandler<P> } = {
  "/machine/sync": sync,
  "/machine/operations/acknowledge": acknowledge,
  "/machine/inspections/respond": respond,
  "/machine/github/accounts": machineGitHubAccounts,
  "/machine/repositories/connect": connectRepository,
  "/machine/repositories/disconnect": disconnectRepository,
  "/machine/repositories/readiness": repositoryReadiness,
  "/machine/repositories/set-automatic": setAutomatic,
  "/machine/repositories/set-infra-rerun": setInfraRerun,
  "/machine/repositories/set-capacity-mode": setCapacityMode,
  "/machine/repositories/set-cache-volume": setCacheVolume,
  "/machine/repositories/set-access": setAccess,
  "/machine/jobs/list": listJobs,
  "/machine/jobs/scan": scanJobs,
  "/machine/jobs/refresh": refreshJob,
  "/machine/jobs/logs": jobLogs,
  "/machine/runners/reconcile": reconcileRunner,
  "/machine/runners/prepare": prepareRunner,
  "/machine/runners/status": runnerStatus,
  "/machine/runners/release": releaseRunner,
  "/machine/scale-sets/open": openScaleSet,
  "/machine/scale-sets/refresh": refreshScaleSet,
  "/machine/scale-sets/close": closeScaleSet,
  "/machine/runs/control": controlRun,
  "/machine/migrations/analyze": analyzeMigration,
  "/machine/migrations/publish": publishMigration,
};

const humanRoutes: { [P in HumanPath]: HumanHandler<P> } = {
  "/account/remove": removeAccount,
  "/pairings/approve": approvePairing,
  "/controllers/approve": approveController,
  "/controllers/revoke": revokeController,
  "/machines/remove": removeMachine,
  "/github/accounts/unlink": unlinkAccount,
  "/github/links/discard": discardLink,
  "/repositories/enable": enableRepository,
  "/repositories/disable": disableRepository,
};

const rawRoutes: Record<string, RawHandler> = {
  "POST /machine/pairing": machinePairing,
  "POST /controller/pairing": controllerPairing,
  "POST /controller/request": controllerRequest,
  "POST /github/webhook": githubWebhook,
  "POST /clerk/webhook": clerkWebhook,
  "GET /github/app/setup": appSetup,
  "GET /github/manifest/callback": manifestCallback,
  "GET /github/oauth/callback": oauthCallback,
  "POST /github/oauth/begin": oauthBegin,
  "POST /github/oauth/confirm": oauthConfirm,
};

const isMachinePath = (path: string): path is MachinePath => Object.hasOwn(MachineApi, path);
const isHumanPath = (path: string): path is HumanPath => Object.hasOwn(HumanApi, path);

// Machine requests are small except job logs, migration reports and inspection responses.
const machineBodyLimit = 512 * 1024;
const humanBodyLimit = 16 * 1024;

function corsHeaders(env: Env, request: Request): Record<string, string> {
  return request.headers.get("Origin") === env.VECTIS_WEB_URL
    ? {
        "Access-Control-Allow-Origin": env.VECTIS_WEB_URL,
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
    : {};
}

function errorResponse(error: unknown) {
  if (error instanceof CloudError) return json(error.body(), error.status);
  console.error(error);
  return json({ code: "cloud_unavailable" }, 500);
}

async function machineSocket(c: Context, request: Request) {
  if (request.headers.get("Upgrade") !== "websocket")
    throw new CloudError("websocket_required", 426);
  const machine = await authenticateMachine(c.env, socketCredential(request));
  const headers = new Headers(request.headers);
  headers.set("X-Vectis-Machine", machine.id);
  return hubFor(c.env, machine.id).fetch(new Request(request, { headers }));
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const c: Context = { env, ctx };
  if (request.method === "GET" && path === "/machine/socket") return machineSocket(c, request);
  if (request.method === "POST" && isMachinePath(path)) {
    const machine = await authenticateMachine(env, bearerCredential(request));
    const input = decode(MachineApi[path].request, await readJson(request, machineBodyLimit));
    const handler = machineRoutes[path] as MachineHandler<typeof path>;
    return json(await handler({ env, ctx, machine }, input as never));
  }
  if (path === "/account/overview" || isHumanPath(path)) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    // Browsers send Origin on every cross-origin request; refuse any other origin outright.
    if (request.headers.get("Origin") !== null && !cors["Access-Control-Allow-Origin"])
      throw new CloudError("origin_refused", 403);
    const owner = await authenticateHuman(env, request);
    if (request.method === "GET" && path === "/account/overview")
      return json(await overview({ env, ctx, owner }), 200, cors);
    if (request.method === "POST" && isHumanPath(path)) {
      const input = decode(HumanApi[path].request, await readJson(request, humanBodyLimit));
      const handler = humanRoutes[path] as HumanHandler<typeof path>;
      return json(await handler({ env, ctx, owner }, input as never), 200, cors);
    }
  }
  const raw = rawRoutes[`${request.method} ${path}`];
  if (raw) return raw(c, request);
  return json({ code: "not_found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      // Error bodies carry CORS headers too, so the browser exposes them to /connect.
      const response = errorResponse(error);
      for (const [name, value] of Object.entries(corsHeaders(env, request)))
        response.headers.set(name, value);
      return response;
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.cron, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
