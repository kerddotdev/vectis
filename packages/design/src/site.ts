export const site = {
  url: "https://vectis.kerd.dev",
  author: { name: "kerd.dev", url: "https://kerd.dev" },
  repository: "https://github.com/kerddotdev/vectis",
  // GitHub redirects this to the asset of the latest non-prerelease release.
  download: "https://github.com/kerddotdev/vectis/releases/latest/download/Vectis-arm64.dmg",
  navigation: [
    { href: "/features", label: "Features" },
    { href: "/security", label: "Security" },
    { href: "/docs", label: "Docs" },
    { href: "/changelog", label: "Changelog" },
  ],
} as const;

export const themeStorageKey = "blume-theme";
