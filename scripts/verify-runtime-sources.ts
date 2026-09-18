import { parseArgs } from "node:util";
import { verifyRuntimeSources } from "./release/verify-runtime-sources.js";

const { values } = parseArgs({
  options: { runtime: { type: "string" }, sources: { type: "string" } },
});
if (!values.runtime || !values.sources)
  throw Error("Provide --runtime <bundled-windows-runtime> and --sources <collected-sources>.");
console.log(JSON.stringify(await verifyRuntimeSources(values.runtime, values.sources)));
