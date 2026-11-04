import { mapLimit } from "@/core/concurrency";
import type { LearningDataPort, PersonCourse } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";

/** Per-person course progress (one LMS call per person). Callers enforce the people cap. */
export async function loadPersonCourses(
  port: LearningDataPort,
  tenant: TenantConfig,
  userIds: number[],
): Promise<Map<number, Map<number, PersonCourse>>> {
  const rows = await mapLimit(userIds, tenant.limits.upstreamConcurrency, (id) => port.listPersonCourses(id));
  const out = new Map<number, Map<number, PersonCourse>>();
  userIds.forEach((id, i) => out.set(id, new Map((rows[i] ?? []).map((c) => [c.courseId, c]))));
  return out;
}

/** Quiz percentages per course and user (one LMS call per course). */
export async function loadScores(
  port: LearningDataPort,
  tenant: TenantConfig,
  courseIds: number[],
): Promise<Map<number, Map<number, number[]>>> {
  const modules = new Set(tenant.scoring.itemModules);
  const perCourse = await mapLimit(courseIds, tenant.limits.upstreamConcurrency, (id) =>
    port.getCourseGrades(id),
  );
  const out = new Map<number, Map<number, number[]>>();
  courseIds.forEach((courseId, i) => {
    const byUser = new Map<number, number[]>();
    for (const g of perCourse[i] ?? []) {
      const pcts = g.items
        .filter((it) => it.type === "mod" && it.module !== null && modules.has(it.module))
        .filter((it) => it.raw !== null && it.max !== null && it.max > 0)
        .map((it) => (it.raw! / it.max!) * 100);
      if (pcts.length) byUser.set(g.userId, pcts);
    }
    out.set(courseId, byUser);
  });
  return out;
}
