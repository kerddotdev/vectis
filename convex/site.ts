export function webUrl() {
  const value = process.env.VECTIS_WEB_URL;
  if (!value || !/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(value))
    throw new Error("VECTIS_WEB_URL must be the HTTPS origin that serves the connect page.");
  return value;
}

export function githubApp() {
  return {
    name: process.env.VECTIS_GITHUB_APP_NAME || "Vectis",
    public: process.env.VECTIS_GITHUB_APP_PUBLIC !== "false",
  };
}
