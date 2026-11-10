import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@clerk/react";
import type {
  AccountOverview,
  HumanPath,
  HumanRequest,
  HumanResponse,
} from "../../../../packages/protocol/src/cloud.js";

export const cloudUrl = import.meta.env.VECTIS_CLOUD_URL || undefined;

export class CloudRequestError extends Error {
  constructor(
    readonly code: string,
    readonly nextStep?: string,
  ) {
    super(code);
  }
}

export function errorCode(issue: unknown) {
  return issue instanceof CloudRequestError ? issue.code : "";
}

type Call = <P extends HumanPath>(path: P, input: HumanRequest<P>) => Promise<HumanResponse<P>>;
interface Cloud {
  call: Call;
  overview: AccountOverview | undefined;
  refresh: () => void;
}
const CloudContext = createContext<Cloud | null>(null);

// The overview refreshes while the page is visible, on focus, and after every change made here.
// Changes made elsewhere (a Mac connecting a repository) show up within the interval.
const refreshInterval = 15000;

export function CloudProvider({ url, children }: { url: string; children: ReactNode }) {
  const { getToken } = useAuth();
  const [overview, setOverview] = useState<AccountOverview>();
  const generation = useRef(0);
  const request = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const token = await getToken();
      if (!token) throw new CloudRequestError("unauthorized");
      let response: Response;
      try {
        response = await fetch(`${url}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
      } catch {
        throw new CloudRequestError("cloud_unavailable");
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const issue = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        throw new CloudRequestError(
          typeof issue.code === "string" ? issue.code : "cloud_unavailable",
          typeof issue.nextStep === "string" ? issue.nextStep : undefined,
        );
      }
      return body;
    },
    [getToken, url],
  );
  const refresh = useCallback(() => {
    const current = ++generation.current;
    request("/account/overview")
      .then((value) => {
        if (current === generation.current) setOverview(value as AccountOverview);
      })
      .catch(() => {});
  }, [request]);
  useEffect(() => {
    refresh();
    const tick = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(tick, refreshInterval);
    addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);
  const call = useCallback<Call>(
    async (path, input) => {
      try {
        return (await request(path, {
          method: "POST",
          body: JSON.stringify(input),
        })) as HumanResponse<typeof path>;
      } finally {
        refresh();
      }
    },
    [request, refresh],
  );
  const value = useMemo(() => ({ call, overview, refresh }), [call, overview, refresh]);
  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud() {
  const cloud = useContext(CloudContext);
  if (!cloud) throw new Error("useCloud needs a CloudProvider.");
  return cloud;
}

export type Machines = AccountOverview["machines"];
export type Identity = AccountOverview["github"];
export type Bindings = AccountOverview["bindings"];
export type Controllers = AccountOverview["controllers"];
