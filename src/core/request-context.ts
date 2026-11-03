import { AsyncLocalStorage } from "node:async_hooks";

/** Per-request bookkeeping: correlation id, upstream call stats and the time budget. */
export interface RequestState {
  requestId: string;
  startedAt: number;
  /** Absolute epoch-ms after which no new upstream call may start. */
  deadline: number;
  upstreamCalls: number;
  upstreamMs: number;
}

const storage = new AsyncLocalStorage<RequestState>();

export const requestContext = {
  run<T>(state: RequestState, fn: () => T): T {
    return storage.run(state, fn);
  },
  get(): RequestState | undefined {
    return storage.getStore();
  },
};

export function newRequestState(budgetMs: number, requestId = crypto.randomUUID()): RequestState {
  const now = Date.now();
  return { requestId, startedAt: now, deadline: now + budgetMs, upstreamCalls: 0, upstreamMs: 0 };
}
