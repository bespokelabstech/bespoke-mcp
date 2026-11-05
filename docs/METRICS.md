# Metric definitions

`definitions_version: 2026-11-mvp3` (returned in every response). Any change in meaning must
update this file and bump `DEFINITIONS_VERSION` in `src/domain/envelope.ts`.

Everything is pulled live from Moodle's standard web services; nothing is stored. Items
marked **[verify]** still need confirming on staging.

## Population

Every enrolled account gets exactly one status. Counts per status are returned with every
aggregate (`population`), in the same unit as the answer (people or enrolments).

| Status (input value)          | Rule (first match wins)                                                                                                                                                                                                                                                                  | Counted by default? |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **excluded** · reason `role`  | Not a `student` in the course, or holds `redemptionmanager`                                                                                                                                                                                                                              | No                  |
| **excluded** · reason `test`  | Username on the exclusion list / range (staging: UAT pool `111111111119`–`111111111169`)                                                                                                                                                                                                 | No                  |
| **excluded** · reason `staff` | Dealer Level is `PC Center of Excellence` (sampled: every staff row, incl. 4-digit employee numbers)                                                                                                                                                                                     | No                  |
| **excluded** · reason `dummy` | Conso ID matches a placeholder pattern: one digit repeated at any length (`0`, `000`, `00000`, `111111111111`), a 2–3-digit block repeated (`123123123123`), the `1111111111xx` test series (`111111111112`)                                                                             | No                  |
| **dealer**                    | Conso ID — from `dealer_conso_id`, else the username — is 12 lower-case letters/digits after trimming, lower-casing and repairing a dropped leading zero (11 digits → 12). Covers canonical `BBBB` + 8 digits (BBBB = branch code) and PC alphanumeric forms (`500000j…`, `0032000il…`). | **Yes**             |
| **legacy**                    | Anything else: no Conso ID, or an old/malformed format (`fb 007700901`, `nl_0999_0007`, `glp_00099`, 9-digit, and the 10-character "branch + 6 digits" format — business decision 2026-11-04)                                                                                            | No                  |

- **Dealers are counted once per Conso ID**: duplicate accounts (seen on staging, e.g. the
  same ID with and without the leading zero) merge. Legacy/excluded count per account. When
  any merged, `population.dealer_duplicate_accounts_merged` says how many accounts merged.
- Values typed instead of an ID that mean "none" (`n/a`, `na`, `none`, `null`, `nil`, `-`) are
  treated as empty.
- Callers can choose the population: `["dealer"]` (default), `["dealer","legacy"]`, `["legacy"]`, …
- Test accounts with a legitimate ID structure (e.g. `000700099515`) count as Dealers by design.
- The server never edits identifiers; fixing a profile in Moodle moves the account on the next query.

## Business attributes

| Dimension    | Source (profile field)           | Value used                                                                                                          |
| ------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Region       | `Region_Dropdown`                | Verbatim; empty → `N/A`                                                                                             |
| Dealer Level | `level`                          | Verbatim (`Great Life Builder` / `Manager` / `Director` / `Executive`, `PC Center of Excellence`); empty → `N/A`    |
| Branch       | `branch_code`                    | Stored label verbatim (e.g. `QUEZON AVE (0032)`) plus parsed `branch_name`, `branch_code`; bare `0032` → name `N/A` |
| Conso ID     | `dealer_conso_id`, else username | normalised as above                                                                                                 |

The system's stored values are the source of truth: nothing is merged or renamed.
Look-alike values (`Visayas` next to `Visayas 1/2/3`, `Mindanao` next to `Mindanao 1/2/3`)
are separate values; responses add a note so the reader can clarify which is meant.

Filters match case-insensitively and exactly; Branch filters match the label, name or code;
`N/A` selects empty values.

## Engagement signals

| Signal                       | Definition                                                                       | Sees mobile app?                                                 | Cost                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ |
| `started` (default)          | Completed at least one activity (course progress > 0%) or completed the course   | **Yes** — verified: an app PDF completion moved progress 0 → 25% | 1 call / person; batched, answered in parts when large |
| `completion`                 | `completed` and `progress %` over enrolments in courses with completion tracking | Yes                                                              | 1 call / person                                        |
| `site_last_access` (default) | Last access to the site, incl. app logins; not per course                        | Yes **[verify]**                                                 | cheap                                                  |
| `web_course_access`          | Last time the course was opened in a web browser                                 | **No** — verified: opening a course in the app leaves it empty   | cheap                                                  |
| `avg_score`                  | Mean of graded quiz results (grade / max × 100) over graded quiz items           | Yes                                                              | 1 call / course                                        |

Limits of `started`: opening a course or partly viewing an activity without completing it
does not count; progress has no date, so `started` cannot be windowed.

`web_course_access` is always returned with a "web only" warning and must never be presented
as overall course access.

### Metrics per group

| Field                                                     | Meaning                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `enrolled`                                                | Units (people or enrolments) in the group                  |
| `started.count` / `rate_pct`                              | Units that started / units with known progress             |
| `started.unknown`                                         | Units the LMS returned no progress for                     |
| `completion.tracked_enrolments`                           | Enrolments in courses with completion where a state exists |
| `completion.completed` / `completion_rate_pct`            | Completed tracked enrolments / rate                        |
| `completion.avg_progress_pct`                             | Mean progress % over tracked enrolments                    |
| `site_last_access.ever` / `in_window` / `window_rate_pct` | Units with a site access / in the window / rate            |
| `web_course_access.*`                                     | Same, for web course access                                |
| `avg_score.graded_items` / `avg_score_pct`                | Graded quiz items / their mean percentage                  |

Rates are `n / d × 100`, 1 decimal, `null` when the denominator is 0.

### Unit (`count_by`)

- `people` (default): each Dealer once per group. Access = most recent across in-scope
  courses and duplicate accounts; started = started ANY in-scope course.
- `enrolments`: each account × course enrolment as Moodle records it (a Dealer with two accounts in a course counts twice — duplicates merge only in `people`). This keeps enrolment answers additive, so answers in parts equal a single pass. Grouping by course always counts enrolments.
- Completion and score are always enrolment-based.

### Time windows (timezone Asia/Manila)

| Input                                       | Semantics                             | Exact?                                    |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------- |
| `recent_days: N`                            | last access ≥ now − N×24h             | **Yes**                                   |
| `since: D` (no `until`, or `until` ≥ today) | last access ≥ 00:00 on D              | **Yes**                                   |
| `since: D1, until: D2` (D2 in the past)     | last access in [D1 00:00, D2+1 00:00) | **No** — `last_access_in_range` + warning |

Moodle keeps only the most recent access, so past ranges under-count anyone who accessed
again later. Exact history needs the activity log (read-only plugin, see ROADMAP).

## Answer size and parts

Questions that do not fit one call (≈50 s) are answered **in parts**: the response carries
`complete: false`, `progress` and a signed `next_cursor` (running sums and position — the
server stores nothing). Claude calls again with the same arguments plus the cursor.

| Question type                                                                         | Work unit per part                                                                           | Rows per part                                                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Enrolment-level, cheap signals (`site_last_access`, `web_course_access`, `avg_score`) | one page (500 enrolments) of one course — large courses split mid-course                     | grouped by course: rows for courses finished in that part; otherwise all rows with the last part |
| Per-person signals (`started`, `completion`)                                          | a batch of people (all their courses in one LMS call each), resumed by last processed person | all rows with the last part                                                                      |
| People-level counts without per-person signals                                        | must fit one call                                                                            | —                                                                                                |

`skipped_signals` lists any requested signal that could not be computed: `avg_score` without
the grade report function, or `avg_score` requested together with `started`/`completion`
(grade reports are per course; ask for it in a separate query). Breakdowns with too many
groups to carry between parts (e.g. hundreds of branches) fail fast with a suggestion to
group by course or add a filter. Final numbers from parts equal a single-pass answer
(tested). Each part re-reads live data, so changes made in Moodle between parts can show up.

## Source map

| Field                                                       | Moodle function                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Courses, categories                                         | `core_course_get_courses_by_field`, `core_course_get_categories` |
| Enrolments, roles, site/web last access (no profile fields) | `core_enrol_get_enrolled_users`                                  |
| Profile fields (once per account, batched)                  | `core_user_get_users_by_field` (field `id`)                      |
| Person lookup by Conso ID                                   | `core_user_get_users_by_field` (field `username`)                |
| Per-person courses, progress, completed                     | `core_enrol_get_users_courses`                                   |
| Quiz grades                                                 | `gradereport_user_get_grade_items`                               |
| Capability detection                                        | `core_webservice_get_site_info`                                  |

## Known differences from the GLA admin dashboard

The dashboard API (`gla-compliance-custom-api`) uses different rules (site `lastlogin` /
`lastaccess` engagement, no Conso-ID rule, region derived from the branch catalog, quiz pass
computed against `gradepass` in points). Numbers will not match it one-for-one.
