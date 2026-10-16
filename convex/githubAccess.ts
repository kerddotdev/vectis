"use node";
import { ConvexError } from "convex/values";
import {
  GitHubAppClient,
  GitHubApprovalError,
  GitHubAdminError,
  GitHubInstallationError,
  GitHubPermissionError,
  GitHubAccessError,
  GitHubUnavailableError,
  GitHubRateLimitError,
} from "../packages/github/src/app-client.js";

export async function repositoryAccess(
  client: GitHubAppClient,
  input: Parameters<GitHubAppClient["repositoryToken"]>[0],
) {
  try {
    return await githubErrors(() => client.repositoryToken(input));
  } catch (error) {
    if (
      error instanceof GitHubApprovalError ||
      error instanceof GitHubAdminError ||
      error instanceof GitHubInstallationError ||
      error instanceof GitHubPermissionError ||
      error instanceof GitHubAccessError
    )
      throw new ConvexError({ code: error.code, message: error.message, nextStep: error.nextStep });
    throw error;
  }
}

export async function githubErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitHubUnavailableError || error instanceof GitHubRateLimitError)
      throw new ConvexError({
        code: error.code,
        status: error.status,
        message: error.message,
        nextStep: error.nextStep,
        ...(error instanceof GitHubRateLimitError && error.resetAt !== undefined
          ? { resetAt: error.resetAt }
          : {}),
      });
    throw error;
  }
}
