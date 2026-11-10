import { notImplemented, type HumanHandler, type RawHandler } from "./context.js";

export const approveController: HumanHandler<"/controllers/approve"> = async () => notImplemented();
export const revokeController: HumanHandler<"/controllers/revoke"> = async () => notImplemented();
// POST /controller/pairing
export const controllerPairing: RawHandler = async () => notImplemented();
// POST /controller/request: authenticates with auth/controller.ts and answers ControllerResponses.
export const controllerRequest: RawHandler = async () => notImplemented();
