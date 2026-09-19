import type { Flavor } from "../../packages/client/src/build.js";

export function desktopIdentity(flavor: Flavor) {
  return flavor === "production"
    ? {
        name: "Vectis",
        bundleId: "com.kerddotdev.vectis",
        artifact: "Vectis",
        updates: { owner: "kerddotdev", repo: "vectis" },
      }
    : {
        name: "Vectis Dev",
        bundleId: "com.kerddotdev.vectis.dev",
        artifact: "Vectis-Dev",
        updates: undefined,
      };
}
