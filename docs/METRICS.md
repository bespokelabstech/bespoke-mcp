# Metric definitions

`definitions_version: 2026-11-mvp6` (returned in every response). Any change in meaning must
update this file and bump `DEFINITIONS_VERSION` in `src/domain/envelope.ts`.

Labels, defaults, filters and sort follow **BES-465** (Compliance Dashboard v2), so this
connector and the dashboard use the same words with the same meaning. Everything is still
pulled live from Moodle's standard web services; nothing is stored, and nothing calls the
dashboard or its API. Where the standard API cannot measure a term the way BES-465 defines it,
the term carries an "In this connector" note (in `describe_capabilities` → `glossary`) and
responses carry a warning.

## Glossary (BES-465, word for word) and how this connector measures it

| Label                       | Meaning (BES-465)                                                                                             | In this connector                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account                     | A learner account: has the student role and no trainer or admin role. Always applied, not a filter.           | Roles read per course (`student`, none of `editingteacher`, `teacher`, `manager`, `coursecreator`, `redemptionmanager`). Site-level admin roles are not visible.     |
| Valid dealer                | Not hidden by the `valid_dealers` saved filter (rules below). This includes being one of the 4 dealer levels. | Same 7 rules as patterns (pending Jona's confirmation); unexpected Dealer Levels are flagged in a warning                                                            |
| Enrolled                    | Enrolled in the course. Enrolment differs by Dealer Level (`local_enrolrules`).                               | Exact                                                                                                                                                                |
| Logged in                   | Signed in to the app at least once. Within a date range: had a session in the range.                          | Last sign-in only (app sign-in or web visit). Exact for ranges ending today; past ranges under-count people who signed in again later                                |
| Sessions                    | App use. A new session starts after 30 minutes idle.                                                          | Not available (needs session tracking)                                                                                                                               |
| Days active                 | Days with at least one session                                                                                | Not available                                                                                                                                                        |
| Last active                 | Last app use. Falls back to last sign-in until session data exists.                                           | Last sign-in (the fallback)                                                                                                                                          |
| Accessed                    | Completed at least one activity in the course. Within a date range: completed one in the range.               | All-time only; a date range is not applied (warning). Verified: an app PDF completion moved progress 0 → 25%                                                         |
| Access rate                 | Accessed ÷ logged in, for a course                                                                            | Accessed ÷ accounts with a sign-in on record; `null` when a date range is set (warning)                                                                              |
| Progress                    | % of a course's activities completed                                                                          | Exact (Moodle progress %)                                                                                                                                            |
| First / Last progress       | Dates of the first and latest completed activity in a course                                                  | Not available (no completion dates in bulk)                                                                                                                          |
| Completed / Avg. completion | Finished the course / share of enrolments completed                                                           | Exact; Avg. completion = completed ÷ **enrolled** enrolments (courses without completion tracking count as not completed and are reported as `untracked_enrolments`) |
| Region                      | Taken from the dealer's branch in Branches & Regions                                                          | **Different source:** the Region value stored on the profile; responses that filter or group by region say so. Empty shows as "Not set"                              |

Days run midnight to midnight, Manila time.

## Who counts

1. **Base scope (always):** learner accounts only — per course, the `student` role and none of
   the non-learner roles. Trainers and admins never appear, whatever the filters.
2. **Saved filter `valid_dealers` — on by default** (`valid_only: true`). `valid_only: false`
   counts every learner account, including the accounts the filter hides.
3. Every other filter defaults to "all" (all regions, branches, levels, categories).

**Every account counts on its own.** Accounts are never merged (a Dealer with two accounts
counts twice, until one is suspended in Moodle) and identifiers are never repaired.

### `valid_dealers` (BES-465 rules, provisional, `src/tenants/gla/base.ts`)

**An account that matches at least one rule is hidden** while the filter is on. Operators:
`in`, `not_in`, `matches`, `equals`. Fields (values trimmed and lower-cased): `username`;
`conso_id` (profile value as stored, empty when missing); `name` (first + last, empty when
blank); `email` (**only the `@domain`** — the connector drops the rest of the address and never
returns or logs the domain); `status` (`active` / `suspended`); `level` (stored Dealer Level,
empty when blank — the one profile filter BES-465 allows here). Region, branch and category are
rejected at config load.

The patterns are Bespoke's reading of BES-465's rule table (pending Jona's confirmation):

| #   | BES-465 rule                                                                             | Pattern                                                                                | Label                                                                          |
| --- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Email domain bihasa.ph, bespokelabs.tech or training.net                                 | email `matches @(bihasa\.ph\|bespokelabs\.tech\|training\.net)$`                       | Internal email domain                                                          |
| 2   | Username starts `gla.train` / `glass.train`, or contains "test" or "admin"               | username `matches ^(gla\|glass)\.train\|test\|admin`                                   | Test, training or admin username                                               |
| 3   | Name has the whole word DUMMY, TEST, SAMPLE, DEMO, STUDENT or TRY, or is "Admin User"    | name `matches \b(dummy\|test\|sample\|demo\|student\|try)\b`; name `equals admin user` | Test or dummy name                                                             |
| 4   | Dummy Conso ID: 9991 series, one digit repeated with a short suffix, or starts 123456789 | username `matches ^9991\|^(\d)\1{5,}\d{0,3}$\|^123456789`                              | Dummy Conso ID                                                                 |
| 5   | Placeholder name: blank, contains "PC SFLMS Live", or starts with a legacy username      | name `equals ""`; `matches pc sflms live`; `matches ^[a-z]+\d*_[0-9a-z]{3,5}_\d+`      | Placeholder name: blank / PC SFLMS Live / legacy username (one label per part) |
| 6   | Suspended account                                                                        | status `equals suspended`                                                              | Suspended account                                                              |
| 7   | Dealer Level is PC Center of Excellence or blank                                         | level `in ["pc center of excellence", ""]`                                             | COE or blank Dealer Level                                                      |

Guesses to confirm: rule 4 reads "one digit repeated" as 6+ times with up to 3 extra digits
(catches `111111111125` and the staging UAT pool) and "9991 series" as starting with 9991;
rule 5 reads "legacy username" as letters + optional digits, `_`, 3–5 characters, `_`, digits
(`cl_0106_00003`, `sl2_0575c_00012`; not `glp_00099`).

**Not rules (BES-465):** duplicates count until suspended; "never logged in" is a status filter
(here: `list_people` `where: {signal: logged_in, state: no}`); bad branch codes count.

**Warnings:** if any account in an answer has no visible email domain (or suspension flag),
the rule cannot hide it and the answer says how many (Moodle shows emails only when an account
allows it, unless the service role has `moodle/site:viewuseridentity`). Answers in parts carry
these facts across parts, so the final part reports them. A Dealer Level outside the 4 dealer levels and COE
is flagged (the glossary's "one of the 4 dealer levels" and rule 7 agree only while no other
value exists — true on staging, 2026-11-09).

Every response carries `population`: `learner_accounts`, `valid_dealers`, `counted`;
`not_valid` = hidden accounts by their **first** matching rule label (adds up to the hidden
total); `matched_by_rule` = **every** account each label matches (overlapping, so it can add up
to more). Rule 5's three parts have their own labels (`Placeholder name: blank / PC SFLMS Live /
legacy username`) — add them up for BES-465's single "Placeholder name" rule. A name the LMS did
not return is treated as unknown, not blank: name rules skip it and the answer warns.

## Profile attributes

| Dimension    | Source (profile field) | Value used                                                                                                              |
| ------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Region       | `Region_Dropdown`      | Verbatim; empty → `Not set`                                                                                             |
| Dealer Level | `level`                | Verbatim; empty → `Not set`                                                                                             |
| Branch       | `branch_code`          | Stored label verbatim (e.g. `QUEZON AVE (0032)`) plus parsed `branch_name`, `branch_code`; bare `0032` → name `Not set` |
| Conso ID     | `dealer_conso_id`      | As stored (trimmed); when empty, the username is shown with `conso_id_from_username: true` (display only)               |

Look-alike values (`Visayas` next to `Visayas 1/2/3`) are separate values; responses add a note.

## Filter contract (same as the BES-465 reporting API, minus `status` and `q`)

| Input                                   | Meaning                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `from`, `to` / `recent_days`            | Date range (Manila days). See below                                              |
| `valid_only`                            | Saved filter on (default) / off                                                  |
| `filters.{region,level,branch}`         | Include lists — case-insensitive exact match; branch matches label, name or code |
| `exclude.{region,level,branch}`         | Exclude lists (default: none)                                                    |
| `category_ids` / `exclude_category_ids` | Include / exclude courses by category (sub-categories included)                  |
| `sort`                                  | Any column, `-` prefix for descending; nulls last                                |

`list_people` adds `search` (name, username or Conso ID) — the equivalent of `q`.

### Date ranges (timezone Asia/Manila)

| Input                                | Logged in / web course access          | Exact?                                    |
| ------------------------------------ | -------------------------------------- | ----------------------------------------- |
| `recent_days: N`                     | last sign-in ≥ now − N×24h             | **Yes**                                   |
| `from: D` (no `to`, or `to` ≥ today) | last sign-in ≥ 00:00 on D              | **Yes**                                   |
| `from: D1, to: D2` (D2 in the past)  | last sign-in in [D1 00:00, D2+1 00:00) | **No** — `last_access_in_range` + warning |

Accessed, Progress and scores are never limited by a date range; with a range, Access rate is
`null` and a warning says so.

## Metrics (`signals`) and output fields

| Signal                | Output                                                                                                            | Cost                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `logged_in` (default) | `logged_in.count`, `pct_of_enrolled`; with a range also `ever`                                                    | cheap                               |
| `accessed` (default)  | `accessed.count`, `access_rate_pct` (÷ logged in), `unknown` (no progress returned)                               | 1 call / account; batched, in parts |
| `progress`            | `progress.enrolments`, `completed`, `avg_completion_pct` (÷ enrolled), `avg_progress_pct`, `untracked_enrolments` | 1 call / account                    |
| `web_course_access`   | `ever`, `in_window`, `window_rate_pct` — **web only**, always with a warning                                      | cheap                               |
| `avg_score`           | `graded_items`, `avg_score_pct` (graded quizzes, grade / max × 100)                                               | 1 call / course                     |

Rates are `n / d × 100`, 1 decimal, `null` when the denominator is 0. Per Course (group by
course): Logged in and Completed are shares of enrolled; Accessed comes as the access rate —
as in BES-465.

### Unit (`count_by`) and grouping

- `accounts` (default): each account once per group. Logged in = the account's last sign-in;
  accessed = accessed ANY in-scope course in the group.
- `enrolments`: each account × course enrolment; additive, so answers in parts equal one pass.
- `group_by`: up to two of `region`, `level`, `branch`, `course`, `category`. Grouping by course
  always counts enrolments. Progress and score are always enrolment-based.

### Sort

- `query_metrics`: `enrolled` (default `-enrolled`), `group`, `logged_in`, `logged_in_pct`,
  `accessed`, `access_rate`, `avg_progress`, `completed`, `avg_completion`, `web_course_access`,
  `avg_score`. A column needs its metric in `signals`.
- `list_people`: `name` (default), `conso_id`, `region`, `branch`, `level`, `last_sign_in`,
  `web_course_access`, `progress`, `accessed`; `progress`/`accessed` need one call per account
  and work up to 300 matching accounts. `enrolment_order` browses very large courses.

## Answer size and parts

Questions that do not fit one call (≈50 s) are answered **in parts**: `complete: false`,
`progress` and a signed `next_cursor` (running sums and position — the server stores nothing).
Claude calls again with the same arguments plus the cursor. **Rows and totals come with the
last part**, so they can be sorted on any column.

| Question type                                                                  | Work unit per part                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Enrolment-level, cheap signals (`logged_in`, `web_course_access`, `avg_score`) | one page (500 enrolments) of one course — large courses split mid-course         |
| Per-account signals (`accessed`, `progress`)                                   | a batch of accounts (all their courses in one LMS call each), resumed by account |
| Account-level counts without per-account signals                               | must fit one call                                                                |

`skipped_signals` lists a requested signal that could not be computed (`avg_score` without the
grade report function, or together with `accessed`/`progress` — ask separately). Breakdowns with
too many groups to carry between parts fail fast with a suggestion. Each part re-reads live data.

## Source map

| Field                                                     | Moodle function                                                  |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| Courses, categories                                       | `core_course_get_courses_by_field`, `core_course_get_categories` |
| Enrolments, course roles, last sign-in, web course access | `core_enrol_get_enrolled_users`                                  |
| Profile fields (once per account, batched)                | `core_user_get_users_by_field` (field `id`)                      |
| Account lookup by username                                | `core_user_get_users_by_field` (field `username`)                |
| Per-account courses, progress, completed                  | `core_enrol_get_users_courses`                                   |
| Quiz grades                                               | `gradereport_user_get_grade_items`                               |
| Capability detection                                      | `core_webservice_get_site_info`                                  |

## Known differences from the BES-465 dashboard

Same labels, filters, defaults and sort. Numbers can still differ where the data source does:
Logged in within a past range and Accessed within a range (no session or completion history),
Region (profile value vs Branches & Regions), and site-level admin roles (not visible here).
The plan to remove these gaps is to read the dashboard's reporting API (`/reporting/v1`) as a
second connector once it ships — see ROADMAP.
