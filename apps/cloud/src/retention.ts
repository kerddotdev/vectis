import { notImplemented, type Sweep } from "./context.js";

// Daily: deletes rows past their retention window and expired short-lived rows (inspections,
// previews, pairings, links, app setups, controllers), in bounded batches.
export const sweepRetention: Sweep = async () => notImplemented();
