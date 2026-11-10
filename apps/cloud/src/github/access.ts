import { CloudError } from "../errors.js";
import {
  GitHubAppClient,
  GitHubApprovalError,
  GitHubAdminError,
  GitHubInstallationError,
  GitHubPermissionError,
  GitHubAccessError,
  GitHubUnavailableError,
  GitHubRateLimitError,
} from "../../../../packages/github/src/app-client.js";

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
      throw new CloudError(error.code, 403, { message: error.message, nextStep: error.nextStep });
    throw error;
  }
}

export async function githubErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GitHubUnavailableError || error instanceof GitHubRateLimitError)
      throw new CloudError(error.code, 502, {
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
