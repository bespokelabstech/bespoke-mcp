import { AppError } from "./errors";
import { requestContext } from "./request-context";

/** Map with bounded concurrency, preserving input order. Stops starting work past the deadline. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      assertWithinBudget();
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function assertWithinBudget(): void {
  const ctx = requestContext.get();
  if (ctx && Date.now() > ctx.deadline) {
    throw new AppError(
      "scope_too_large",
      "This request covers too much data to finish in time. Narrow it (fewer courses, one region, or a smaller group) and try again.",
    );
  }
}
