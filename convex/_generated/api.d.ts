/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as credentials from "../credentials.js";
import type * as githubAppSetup from "../githubAppSetup.js";
import type * as githubDeliveries from "../githubDeliveries.js";
import type * as githubHttp from "../githubHttp.js";
import type * as githubIdentity from "../githubIdentity.js";
import type * as githubOAuth from "../githubOAuth.js";
import type * as githubValidators from "../githubValidators.js";
import type * as githubWebhook from "../githubWebhook.js";
import type * as http from "../http.js";
import type * as httpBody from "../httpBody.js";
import type * as machineTokens from "../machineTokens.js";
import type * as machines from "../machines.js";
import type * as operations from "../operations.js";
import type * as pairings from "../pairings.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  credentials: typeof credentials;
  githubAppSetup: typeof githubAppSetup;
  githubDeliveries: typeof githubDeliveries;
  githubHttp: typeof githubHttp;
  githubIdentity: typeof githubIdentity;
  githubOAuth: typeof githubOAuth;
  githubValidators: typeof githubValidators;
  githubWebhook: typeof githubWebhook;
  http: typeof http;
  httpBody: typeof httpBody;
  machineTokens: typeof machineTokens;
  machines: typeof machines;
  operations: typeof operations;
  pairings: typeof pairings;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
