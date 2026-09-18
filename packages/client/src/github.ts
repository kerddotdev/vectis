export function githubConnection() {
  return {
    state: "action_required",
    url: "https://vectis.kerd.dev/connect?github=1",
    nextStep:
      "Open the connection page, sign in to Vectis, select your GitHub account, and confirm the verified login. Account linking does not enable runner jobs.",
  };
}
