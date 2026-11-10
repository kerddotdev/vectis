import type { Env } from "../env.js";
import { CloudError } from "../errors.js";
import type { GitHubAppRow } from "../db.js";

export async function loadApp(env: Env): Promise<GitHubAppRow> {
  const app = await env.DB.prepare(
    "SELECT * FROM githubApps WHERE singleton = 1",
  ).first<GitHubAppRow>();
  if (!app)
    throw new CloudError("github_app_unavailable", 503, {
      nextStep: "Create the Vectis GitHub App for this deployment before connecting repositories.",
    });
  return app;
}

export async function hasApp(env: Env) {
  return (
    (await env.DB.prepare("SELECT 1 AS present FROM githubApps WHERE singleton = 1").first()) !==
    null
  );
}

// GitHub delivers webhooks straight to this Worker, where their signature is verified, so the
// website can sit entirely behind Cloudflare Access in private deployments.
export const webhookUrl = (env: Env) => `${env.VECTIS_CLOUD_URL}/github/webhook`;

export function appConfig(env: Env) {
  return {
    name: env.VECTIS_GITHUB_APP_NAME || "Vectis",
    public: env.VECTIS_GITHUB_APP_PUBLIC !== "false",
  };
}
