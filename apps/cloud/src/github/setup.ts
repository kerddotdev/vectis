import { notImplemented, type RawHandler } from "../context.js";

// GET /github/app/setup and GET /github/manifest/callback create the GitHub App from a manifest.
export const appSetup: RawHandler = async () => notImplemented();
export const manifestCallback: RawHandler = async () => notImplemented();
