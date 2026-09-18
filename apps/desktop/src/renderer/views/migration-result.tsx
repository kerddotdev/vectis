import { Schema } from "effect";
import {
  MigrationAnalysis,
  MigrationPublication,
} from "../../../../packages/protocol/src/migrations.js";
import { useStateApi } from "./state.js";

export function MigrationResult({ result }: { result: unknown }) {
  const { submit, perform } = useStateApi();
  if (Schema.is(MigrationPublication)(result))
    return (
      <div>
        <p>
          Pull request #{result.number}: {result.state}
        </p>
        <button onClick={() => void perform("open.pull", result.url)}>
          Open GitHub pull request
        </button>
      </div>
    );
  if (!Schema.is(MigrationAnalysis)(result)) return null;
  return (
    <div>
      <p>
        Preview {result.previewId} from {result.baseBranch} at {result.baseCommit.slice(0, 12)}
      </p>
      {!result.verified && (
        <p>
          A successful job and verified runner cleanup are required before publication. Complete
          that check, then analyze again.
        </p>
      )}
      {result.files.length === 0 && <p>No workflow files found.</p>}
      {result.files.map((file) => (
        <details key={file.path}>
          <summary>
            {file.path}: {file.changed ? "Changes proposed" : "Unchanged"}
          </summary>
          {file.findings.map((finding, index) => (
            <p key={index}>
              {finding.job}: {finding.reason}
            </p>
          ))}
          {file.changed && (
            <>
              <h4>Current workflow</h4>
              <pre>{file.before}</pre>
              <h4>Proposed workflow</h4>
              <pre>{file.after}</pre>
            </>
          )}
        </details>
      ))}
      <button
        disabled={!result.verified || !result.files.some((file) => file.changed)}
        onClick={() => void submit({ type: "migration.publish", previewId: result.previewId })}
      >
        Create or recover migration PR
      </button>
    </div>
  );
}
