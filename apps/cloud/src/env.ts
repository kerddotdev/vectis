import type { MachineHub } from "./hub.js";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace<MachineHub>;
  // HTTPS origin that serves /connect. Browser requests from any other origin are refused.
  VECTIS_WEB_URL: string;
  // This Worker's own public origin, used for GitHub webhook and callback URLs.
  VECTIS_CLOUD_URL: string;
  // Clerk Frontend API URL. Human owners are `${CLERK_ISSUER}|${sub}`.
  CLERK_ISSUER: string;
  VECTIS_GITHUB_APP_NAME: string;
  // "false" keeps the GitHub App installable only by its owner.
  VECTIS_GITHUB_APP_PUBLIC: string;
  // Secret (wrangler secret put / .dev.vars): signing secret of the Clerk user.deleted webhook.
  CLERK_WEBHOOK_SECRET?: string;
}
