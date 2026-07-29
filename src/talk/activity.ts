import { randomUUID } from "node:crypto";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { TalkEvent, TalkEventType } from "./talk-events.js";

type TalkActivityState = "idle" | "listening" | "thinking" | "speaking" | "error";

type TalkActivityEventBase = {
  activityId: string;
  timestamp: string;
};

type TalkActivityEvent = TalkActivityEventBase &
  (
    | { type: "started" }
    | { type: "state"; state: TalkActivityState }
    | { type: "speech" }
    | { type: "ended" }
  );

type TalkActivityListener = (event: TalkActivityEvent) => void | Promise<void>;

type ActivityStatus = {
  sessionReady: boolean;
  captureActive: boolean;
  turnActive: boolean;
  outputAudioActive: boolean;
  processing: boolean;
  failed: boolean;
};

type Activity = ActivityStatus & {
  id: string;
  state?: TalkActivityState;
};

type Watcher = {
  listener: TalkActivityListener;
  queue: TalkActivityEvent[];
  draining: boolean;
  closed: boolean;
};

type TalkActivityStateStore = {
  activities: Map<string, Activity>;
  watchers: Set<Watcher>;
};

const MAX_PENDING_EVENTS = 128;
const RESET_STATUS: ActivityStatus = {
  sessionReady: false,
  captureActive: false,
  turnActive: false,
  outputAudioActive: false,
  processing: false,
  failed: false,
};
const STATE_TRANSITIONS = {
  "session.started": "reset",
  "session.ready": { sessionReady: true, failed: false },
  "session.closed": undefined,
  "session.error": { failed: true },
  "session.replaced": undefined,
  "turn.started": { turnActive: true, processing: false, failed: false },
  "turn.ended": {
    turnActive: false,
    outputAudioActive: false,
    processing: false,
    failed: false,
  },
  "turn.cancelled": {
    turnActive: false,
    outputAudioActive: false,
    processing: false,
    failed: false,
  },
  "capture.started": { captureActive: true, processing: false, failed: false },
  "capture.stopped": { captureActive: false, processing: true, failed: false },
  "capture.cancelled": { captureActive: false, processing: false, failed: false },
  "capture.once": undefined,
  "input.audio.delta": { turnActive: true, processing: false, failed: false },
  "input.audio.committed": { processing: true, failed: false },
  "transcript.delta": { turnActive: true, processing: false, failed: false },
  "transcript.done": { processing: true, failed: false },
  "output.text.delta": undefined,
  "output.text.done": undefined,
  "output.audio.started": { outputAudioActive: true, processing: false, failed: false },
  "output.audio.delta": { outputAudioActive: true, processing: false, failed: false },
  "output.audio.done": { outputAudioActive: false, processing: false, failed: false },
  "tool.call": { processing: true, failed: false },
  "tool.progress": { processing: true, failed: false },
  "tool.result": { processing: true, failed: false },
  "tool.error": { failed: true },
  "usage.metrics": undefined,
  "latency.metrics": undefined,
  "health.changed": undefined,
} satisfies Record<TalkEventType, "reset" | Partial<ActivityStatus> | undefined>;
const processState = resolveGlobalSingleton<TalkActivityStateStore>(
  Symbol.for("openclaw.talkActivity"),
  () => ({ activities: new Map(), watchers: new Set() }),
);

function scheduleDrain(watcher: Watcher): void {
  if (watcher.draining || watcher.closed) {
    return;
  }
  watcher.draining = true;
  queueMicrotask(() => {
    void drainWatcher(watcher);
  });
}

async function drainWatcher(watcher: Watcher): Promise<void> {
  try {
    while (!watcher.closed) {
      const event = watcher.queue.shift();
      if (!event) {
        return;
      }
      try {
        await watcher.listener(event);
      } catch {
        // A plugin watcher must not interrupt Talk delivery.
      }
    }
  } finally {
    watcher.draining = false;
    if (!watcher.closed && watcher.queue.length > 0) {
      scheduleDrain(watcher);
    }
  }
}

function enqueue(watcher: Watcher, event: TalkActivityEvent): void {
  if (watcher.closed) {
    return;
  }
  if (watcher.queue.length >= MAX_PENDING_EVENTS) {
    const speechIndex = watcher.queue.findIndex((queued) => queued.type === "speech");
    if (speechIndex >= 0) {
      watcher.queue.splice(speechIndex, 1);
    } else if (event.type === "speech") {
      return;
    } else {
      watcher.queue.shift();
    }
  }
  watcher.queue.push(event);
  scheduleDrain(watcher);
}

function publish(event: TalkActivityEvent): void {
  for (const watcher of processState.watchers) {
    enqueue(watcher, event);
  }
}

function createActivity(): Activity {
  return {
    id: randomUUID(),
    ...RESET_STATUS,
  };
}

function resolveActivityState(activity: Activity): TalkActivityState {
  if (activity.failed) {
    return "error";
  }
  if (activity.outputAudioActive) {
    return "speaking";
  }
  if (activity.processing) {
    return "thinking";
  }
  if (activity.sessionReady || activity.captureActive || activity.turnActive) {
    return "listening";
  }
  return "idle";
}

function reduceActivityState(activity: Activity, event: TalkEvent): TalkActivityState | undefined {
  const transition = STATE_TRANSITIONS[event.type];
  if (!transition) {
    return activity.state;
  }
  Object.assign(activity, transition === "reset" ? RESET_STATUS : transition);
  return resolveActivityState(activity);
}

function isTerminalEvent(event: TalkEvent): boolean {
  return (
    event.type === "session.closed" ||
    event.type === "session.replaced" ||
    (event.type === "session.error" && event.final === true)
  );
}

export function watchTalkActivity(listener: TalkActivityListener): () => void {
  const watcher: Watcher = { listener, queue: [], draining: false, closed: false };
  processState.watchers.add(watcher);
  return () => {
    watcher.closed = true;
    watcher.queue.length = 0;
    processState.watchers.delete(watcher);
    if (processState.watchers.size === 0) {
      processState.activities.clear();
    }
  };
}

export function recordTalkActivityEvent(event: TalkEvent): void {
  if (processState.watchers.size === 0) {
    return;
  }

  let activity = processState.activities.get(event.sessionId);
  if (!activity) {
    activity = createActivity();
    processState.activities.set(event.sessionId, activity);
    publish({ type: "started", activityId: activity.id, timestamp: event.timestamp });
  }

  const nextState = reduceActivityState(activity, event);
  if (nextState && nextState !== activity.state) {
    activity.state = nextState;
    publish({
      type: "state",
      activityId: activity.id,
      timestamp: event.timestamp,
      state: nextState,
    });
  }

  if (event.type === "output.audio.delta") {
    publish({ type: "speech", activityId: activity.id, timestamp: event.timestamp });
  }

  if (isTerminalEvent(event)) {
    publish({ type: "ended", activityId: activity.id, timestamp: event.timestamp });
    processState.activities.delete(event.sessionId);
  }
}
