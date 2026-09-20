"use node";
import { ConvexError } from "convex/values";
import {
  GitHubAppClient,
  GitHubApprovalError,
  GitHubAdminError,
  GitHubInstallationError,
} from "../packages/github/src/app-client.js";

export async function repositoryAccess(
  client: GitHubAppClient,
  input: Parameters<GitHubAppClient["repositoryToken"]>[0],
) {
  try {
    return await client.repositoryToken(input);
  } catch (error) {
    if (
      error instanceof GitHubApprovalError ||
      error instanceof GitHubAdminError ||
      error instanceof GitHubInstallationError
    )
      throw new ConvexError({ code: error.code, message: error.message, nextStep: error.nextStep });
    throw error;
  }
}
