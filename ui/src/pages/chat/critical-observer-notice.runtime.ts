// Lazy boundary: keeps the critical-notice module (toast host, i18n strings,
// transition tracker) out of the Control UI startup chunk. Loaded by app-host
// on the first session.observer digest; the tracker singleton lives here so
// recovery transitions stay visible to the dedupe contract across loads.
import type { ApplicationRuntime } from "../../app/bootstrap.ts";
import {
  CriticalObserverNoticeTracker,
  showCriticalSessionObserverNotice,
} from "./critical-observer-notice.ts";

const tracker = new CriticalObserverNoticeTracker();

type HandleParams = Omit<Parameters<typeof showCriticalSessionObserverNotice>[0], "tracker">;

export function handleCriticalObserverDigest(params: HandleParams): void {
  const context = document.querySelector<HTMLElement & { runtime?: ApplicationRuntime }>(
    "openclaw-app-shell",
  )?.runtime?.context;
  showCriticalSessionObserverNotice({
    ...params,
    sessionHost: context
      ? {
          assistantAgentId: context.gateway.snapshot.assistantAgentId,
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        }
      : undefined,
    tracker,
  });
}

export function resetCriticalObserverTracker(): void {
  tracker.clear();
}
