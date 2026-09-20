import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.daily("retention sweep", { hourUTC: 3, minuteUTC: 0 }, internal.retention.sweep, {});
export default crons;
