import { AppError } from "@/core/errors";
import type { Category, Course, LearningDataPort } from "@/ports/learning";
import type { TenantConfig } from "@/tenants/schema";

/**
 * Which courses a request covers: the tenant's course scope (categories, exclusions,
 * visible only) intersected with what the caller asked for.
 */

export interface ScopeInput {
  course_ids?: number[] | undefined;
  category_ids?: number[] | undefined;
}

export async function tenantCourses(port: LearningDataPort, tenant: TenantConfig): Promise<Course[]> {
  const [courses, categories] = await Promise.all([port.listCourses(), port.listCategories()]);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const allowed = tenant.courses.includeCategoryIds;
  return courses.filter(
    (c) =>
      c.visible &&
      !tenant.courses.excludeCourseIds.includes(c.id) &&
      (allowed.length === 0 || inCategories(c, allowed, byId)),
  );
}

export async function resolveCourseScope(
  port: LearningDataPort,
  tenant: TenantConfig,
  input: ScopeInput,
  opts: { enforceLimit: boolean } = { enforceLimit: true },
): Promise<Course[]> {
  let courses = await tenantCourses(port, tenant);
  if (input.category_ids?.length) {
    const categories = await port.listCategories();
    const byId = new Map(categories.map((c) => [c.id, c]));
    // A category may be hidden from the service account while its courses are visible, so a
    // category is known if it is listed OR any in-scope course sits in it.
    const unknown = input.category_ids.filter(
      (id) => !byId.has(id) && !courses.some((c) => c.categoryId === id),
    );
    if (unknown.length) throw new AppError("not_found", `Unknown category id(s): ${unknown.join(", ")}.`);
    courses = courses.filter((c) => inCategories(c, input.category_ids!, byId));
  }
  if (input.course_ids?.length) {
    const inScope = new Map(courses.map((c) => [c.id, c]));
    const missing = input.course_ids.filter((id) => !inScope.has(id));
    if (missing.length) {
      throw new AppError(
        "not_found",
        `Course id(s) not found or not in scope: ${missing.join(", ")}. Use list_courses to see available ids.`,
      );
    }
    courses = input.course_ids.map((id) => inScope.get(id)!);
  }
  if (courses.length === 0) throw new AppError("not_found", "No courses match this scope.");
  if (opts.enforceLimit && courses.length > tenant.limits.maxCoursesPerRequest) {
    throw new AppError(
      "scope_too_large",
      `This covers ${courses.length} courses; the limit per request is ${tenant.limits.maxCoursesPerRequest}. ` +
        "Pass course_ids or category_ids to narrow it.",
    );
  }
  return courses;
}

function inCategories(course: Course, categoryIds: number[], byId: Map<number, Category>): boolean {
  const cat = byId.get(course.categoryId);
  const path = cat ? cat.pathIds : [course.categoryId];
  return categoryIds.some((id) => path.includes(id));
}
