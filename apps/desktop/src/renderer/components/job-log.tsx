import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, CheckIcon, CopyIcon, ExternalLinkIcon, HourglassIcon } from "lucide-react";
import { Notice } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { appendChunk, emptyLog, segmentLog, stripAnsi, type LogSegmentKind } from "@/lib/job-log";
import { cn } from "@/lib/utils";
import { readJobLogs, useStateApi } from "@/state";

// Each read costs several GitHub API calls, so an empty log backs off to stay within rate limits.
const pollInterval = 2000;
const maxPollInterval = 30000;
const followThreshold = 40;

const segmentTones: Record<LogSegmentKind, string> = {
  plain: "text-foreground/85",
  error: "text-danger",
  marker: "text-muted-foreground",
};

function wait(signal: AbortSignal, ms: number) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish);
  });
}

// Nothing is read while the window is hidden; the loop picks up again when it is shown.
function untilVisible(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (document.visibilityState === "visible") return resolve();
    const finish = () => {
      if (document.visibilityState === "visible" || signal.aborted) {
        document.removeEventListener("visibilitychange", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", finish);
    signal.addEventListener("abort", finish);
  });
}

export function JobLog({
  bindingId,
  jobId,
  htmlUrl,
}: {
  bindingId: string;
  jobId: number;
  htmlUrl?: string | undefined;
}) {
  const { machineId, perform } = useStateApi();
  const loaded = useRef(emptyLog);
  const [log, setLog] = useState(emptyLog);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [following, setFollowing] = useState(true);
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      setError(undefined);
      let delay = pollInterval;
      try {
        while (!signal.aborted) {
          await untilVisible(signal);
          if (signal.aborted) return;
          const chunk = await readJobLogs(
            { bindingId, jobId, after: loaded.current.next },
            machineId,
          );
          if (signal.aborted) return;
          loaded.current = appendChunk(loaded.current, chunk);
          setLog(loaded.current);
          setReading(false);
          if (chunk.complete) return;
          if (chunk.text !== "") delay = pollInterval;
          else {
            await wait(signal, delay);
            delay = Math.min(delay * 2, maxPollInterval);
          }
        }
      } catch (caught) {
        if (signal.aborted) return;
        setReading(false);
        setError(caught instanceof Error ? caught.message : "The job log could not be read.");
      }
    })();
    return () => controller.abort();
  }, [bindingId, jobId, machineId, attempt]);

  const text = useMemo(() => stripAnsi(log.text), [log.text]);
  const segments = useMemo(() => segmentLog(text), [text]);

  useEffect(() => {
    const element = scroller.current;
    if (element && following) element.scrollTop = element.scrollHeight;
  }, [text, following, wrap]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const waiting = !reading && !error && !log.complete && text === "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          Wrap lines
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={text === ""}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {htmlUrl && (
          <Button variant="ghost" size="xs" onClick={() => void perform("open.url", htmlUrl)}>
            Open on GitHub
            <ExternalLinkIcon />
          </Button>
        )}
      </div>
      {log.truncated && <Notice>Showing the last 4 MiB of this log.</Notice>}
      {error && (
        <Notice
          tone="danger"
          role="alert"
          action={
            <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      )}
      {waiting && (
        <p className="flex items-center gap-2 text-muted-foreground" role="status">
          <HourglassIcon className="size-3.5" aria-hidden />
          Waiting for GitHub to publish the log...
        </p>
      )}
      {reading && <p className="text-muted-foreground">Loading log...</p>}
      {!reading && log.complete && text === "" && (
        <p className="text-muted-foreground">This job has no log output.</p>
      )}
      {text !== "" && (
        <div className="relative">
          <pre
            ref={scroller}
            tabIndex={0}
            aria-label="Job log"
            data-selectable
            onScroll={(event) => {
              const element = event.currentTarget;
              setFollowing(
                element.scrollHeight - element.scrollTop - element.clientHeight <= followThreshold,
              );
            }}
            className={cn(
              "max-h-[28rem] overflow-auto rounded-lg bg-muted p-3 font-mono text-[12px] leading-5 tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              wrap ? "break-words whitespace-pre-wrap" : "whitespace-pre",
            )}
          >
            {segments.map((segment, index) => (
              <span key={index} className={segmentTones[segment.kind]}>
                {segment.text}
              </span>
            ))}
          </pre>
          {!following && (
            <Button
              variant="secondary"
              size="xs"
              className="absolute right-4 bottom-3 shadow-sm"
              onClick={() => setFollowing(true)}
            >
              <ArrowDownIcon />
              Follow latest output
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
