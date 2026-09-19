import type { CloudDeployment } from "./deployment.js";

export function githubConnection(deployment: CloudDeployment) {
  return {
    state: "action_required",
    url: `${deployment.webUrl}/connect?github=1`,
    nextStep:
      "Open the connection page, sign in to Vectis, select your GitHub account, and confirm the verified login. Account linking does not enable runner jobs.",
  };
}
