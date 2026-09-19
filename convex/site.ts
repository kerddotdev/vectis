export function webUrl() {
  const value = process.env.VECTIS_WEB_URL;
  if (!value || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(value))
    throw new Error("VECTIS_WEB_URL must be the HTTPS origin that serves the connect page.");
  return value;
}

// GitHub delivers webhooks straight to Convex, where their signature is verified, so the website
// can sit entirely behind Cloudflare Access in private deployments.
export function webhookUrl() {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not available in this deployment.");
  return `${site}/github/webhook`;
}

export function githubApp() {
  return {
    name: process.env.VECTIS_GITHUB_APP_NAME || "Vectis",
    public: process.env.VECTIS_GITHUB_APP_PUBLIC !== "false",
  };
}
