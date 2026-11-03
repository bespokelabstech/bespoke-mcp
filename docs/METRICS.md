# Metric definitions

`definitions_version: 2026-11-mvp1` (returned in every response). Any change in meaning
must update this file and bump `DEFINITIONS_VERSION` in `src/domain/envelope.ts`.

Status: **draft for business review.** Items marked **[verify]** must be confirmed on staging.

## Population

### Eligible person ("Dealer" for GLA)

A course participant is counted only if **all** hold:

1. Active enrolment in the course (`onlyactive=1`: enrolment active, within dates, method enabled).
2. Holds a required course role (`student`) and none of the excluded course roles
   (`redemptionmanager`).
3. Has an identifier: profile field `dealer_conso_id` is non-empty, **or** the username
   matches `^[a-z0-9]{12}$` (Conso-shaped; keeps legacy accounts).
4. Username is not excluded (staging: UAT pool `111111111119`–`111111111169`).

Excluded users are reported per reason in `excluded_users` so totals are auditable.
**[verify]** whether `onlyactive` also drops site-suspended users.

### Course scope

Visible courses (not the site front page), optionally limited to tenant category ids, minus
excluded course ids. Hidden courses are out of scope.

## Business attributes (GLA)

| Dimension    | Source (profile field)                        | Value used                                                                                                                                                         |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Region       | `Region_Dropdown`                             | Verbatim; empty → `N/A`                                                                                                                                            |
| Dealer Level | `level`                                       | Verbatim (e.g. `Great Life Builder`, `Great Life Manager`, `Great Life Director`, `Great Life Executive`); empty → `N/A`                                           |
| Branch       | `branch_code`                                 | Stored label verbatim (e.g. `QUEZON AVE (0032)`), plus parsed `branch_name` and `branch_code`. Legacy bare `0032` → name `N/A`. Unparseable → name and code `N/A`. |
| Conso ID     | `dealer_conso_id`, else Conso-shaped username | lower-cased                                                                                                                                                        |

The profile is the source of truth. Legacy accounts may hold stale values; they are updated
programmatically when the dealer next signs in, so stale values mostly belong to inactive
accounts.

Filters match case-insensitively; Branch filters match the label, the name or the code;
`N/A` selects empty values.

## Access

| Metric               | Definition                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `enrolled`           | Count of units (see _Unit_) in the group                          |
| `accessed`           | Units with a recorded last course access (`lastcourseaccess > 0`) |
| `never_accessed`     | `enrolled − accessed`                                             |
| `access_rate_pct`    | `accessed / enrolled × 100`, 1 decimal; `null` if enrolled = 0    |
| `accessed_in_window` | Units whose last access falls in the window                       |
| `window_rate_pct`    | `accessed_in_window / enrolled × 100`                             |

### Unit (`count_by`)

- `people` (default): each Dealer once per group. Accessed = accessed **any** in-scope
  Course. Window uses the Dealer's most recent access across in-scope Courses.
- `enrolments`: each Dealer–Course pair once.
- Grouping by Course always counts enrolments.

### Time windows (timezone Asia/Manila)

| Input                                       | Semantics                             | Exact?                          |
| ------------------------------------------- | ------------------------------------- | ------------------------------- |
| `recent_days: N`                            | last access ≥ now − N×24h             | **Yes**                         |
| `since: D` (no `until`, or `until` ≥ today) | last access ≥ 00:00 on D              | **Yes**                         |
| `since: D1, until: D2` with D2 in the past  | last access in [D1 00:00, D2+1 00:00) | **No** — `last_access_in_range` |

The LMS keeps only the **most recent** access. For a past range, a Dealer who accessed in
the range and again afterwards is not counted. Responses carry a warning; Claude is
instructed to say so. Exact historical windows need snapshots or the activity log (ROADMAP).

**[verify]** that mobile-app use updates `lastcourseaccess` (the app talks to Moodle through
web services). If it does not, `never_accessed` over-counts app-only Dealers.

## Completion

Only when `include_completion: true` (summary: scope ≤ 300 Dealers; course list: current
page; dealer detail: always).

| Metric                | Definition                                                                              |
| --------------------- | --------------------------------------------------------------------------------------- |
| `tracked_enrolments`  | Enrolments in Courses with completion enabled where the LMS returned a completion state |
| `completed`           | Tracked enrolments marked complete                                                      |
| `completion_rate_pct` | `completed / tracked_enrolments × 100` (basis: enrolments)                              |
| `avg_progress_pct`    | Mean Moodle course progress % over tracked enrolments with a progress value             |

Courses without completion tracking never count as 0% — they are excluded from the basis.
In `list_courses`, `completion_tracked: null` means Moodle did not disclose the setting to the
service account (unknown, not "off"); per-Dealer data from `core_enrol_get_users_courses` is
authoritative.
**[verify]** the service role can read other users' progress (`report/progress:view`).

## Source map

| Field                                                   | Moodle function                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| Courses, categories                                     | `core_course_get_courses_by_field`, `core_course_get_categories` |
| Participants, roles, profile fields, last course access | `core_enrol_get_enrolled_users`                                  |
| Person lookup by Conso ID                               | `core_user_get_users_by_field` (field `username`)                |
| Per-person courses, last access, progress, completed    | `core_enrol_get_users_courses`                                   |

## Known differences from the GLA admin dashboard

The dashboard API (`gla-compliance-custom-api`) uses different rules (e.g. engagement from
`lastlogin`/`lastaccess` site-wide, no Conso-ID rule, region derived from the branch
catalog). Numbers will not match it one-for-one; compare against these definitions.
