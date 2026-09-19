export function appManifest(
  name: string,
  homepage: string,
  backend: string,
  visibility: { public: boolean } = { public: true },
) {
  for (const value of [homepage, backend]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("GitHub App URLs must use HTTPS without credentials, queries, or fragments.");
  }
  if (!name.trim()) throw new Error("A GitHub App name is required.");
  return {
    name,
    url: homepage,
    description: "Run GitHub Actions on your own machines with Vectis.",
    public: visibility.public,
    hook_attributes: { url: new URL("/github/webhook", backend).href, active: true },
    redirect_url: new URL("/github/manifest/callback", backend).href,
    callback_urls: [new URL("/github/oauth/callback", backend).href],
    setup_url: new URL("/github/setup", homepage).href,
    request_oauth_on_install: true,
    setup_on_update: true,
    default_permissions: {
      administration: "write",
      actions: "read",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      workflows: "write",
    },
    default_events: ["workflow_job", "repository"],
  };
}
