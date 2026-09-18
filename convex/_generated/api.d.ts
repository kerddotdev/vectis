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
import type * as githubAccess from "../githubAccess.js";
import type * as githubAppSetup from "../githubAppSetup.js";
import type * as githubDeliveries from "../githubDeliveries.js";
import type * as githubHttp from "../githubHttp.js";
import type * as githubIdentity from "../githubIdentity.js";
import type * as githubJobs from "../githubJobs.js";
import type * as githubMigrations from "../githubMigrations.js";
import type * as githubOAuth from "../githubOAuth.js";
import type * as githubRepositories from "../githubRepositories.js";
import type * as githubRunnerProbe from "../githubRunnerProbe.js";
import type * as githubRunners from "../githubRunners.js";
import type * as githubValidators from "../githubValidators.js";
import type * as githubWebhook from "../githubWebhook.js";
import type * as http from "../http.js";
import type * as httpBody from "../httpBody.js";
import type * as jobStore from "../jobStore.js";
import type * as jobs from "../jobs.js";
import type * as machineTokens from "../machineTokens.js";
import type * as machines from "../machines.js";
import type * as migrationPreviews from "../migrationPreviews.js";
import type * as operations from "../operations.js";
import type * as pairings from "../pairings.js";
import type * as repositoryBindings from "../repositoryBindings.js";
import type * as runnerDemand from "../runnerDemand.js";
import type * as runnerLeases from "../runnerLeases.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  credentials: typeof credentials;
  githubAccess: typeof githubAccess;
  githubAppSetup: typeof githubAppSetup;
  githubDeliveries: typeof githubDeliveries;
  githubHttp: typeof githubHttp;
  githubIdentity: typeof githubIdentity;
  githubJobs: typeof githubJobs;
  githubMigrations: typeof githubMigrations;
  githubOAuth: typeof githubOAuth;
  githubRepositories: typeof githubRepositories;
  githubRunnerProbe: typeof githubRunnerProbe;
  githubRunners: typeof githubRunners;
  githubValidators: typeof githubValidators;
  githubWebhook: typeof githubWebhook;
  http: typeof http;
  httpBody: typeof httpBody;
  jobStore: typeof jobStore;
  jobs: typeof jobs;
  machineTokens: typeof machineTokens;
  machines: typeof machines;
  migrationPreviews: typeof migrationPreviews;
  operations: typeof operations;
  pairings: typeof pairings;
  repositoryBindings: typeof repositoryBindings;
  runnerDemand: typeof runnerDemand;
  runnerLeases: typeof runnerLeases;
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
