import {
  notImplemented,
  type HumanHandler,
  type MachineHandler,
  type RawHandler,
} from "../context.js";

// POST /github/oauth/begin and /confirm need the Clerk identity (auth/human.ts) and the cookies
// the site Worker forwards; GET /github/oauth/callback is GitHub's redirect.
export const oauthBegin: RawHandler = async () => notImplemented();
export const oauthConfirm: RawHandler = async () => notImplemented();
export const oauthCallback: RawHandler = async () => notImplemented();
export const unlinkAccount: HumanHandler<"/github/accounts/unlink"> = async () => notImplemented();
export const discardLink: HumanHandler<"/github/links/discard"> = async () => notImplemented();
export const machineGitHubAccounts: MachineHandler<"/machine/github/accounts"> = async () =>
  notImplemented();
