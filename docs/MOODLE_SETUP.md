# Moodle service account (read-only)

The MCP server reads Moodle through a **dedicated, restricted** web-service token. Do **not**
reuse tokens other services hold (e.g. `MOODLE_ADMIN_TOKEN` or `MARKETPLACE_WS_TOKEN` in
the Go services) — those can create and update users.

Repeat per environment (staging, production). **Staging is rebuilt from production
(`refresh-staging-from-prod.sh`), which wipes this user, role, service and token** — redo
these steps after every refresh.

All steps are in **Site administration**; no plugin or code change.

## 1. Prerequisites

- _Advanced features_ → **Enable web services** = on.
- _Server → Web services → Manage protocols_ → **REST** enabled (already used by the Go API).

## 2. Service user

_Users → Add a new user_: username `svc_mcp_readonly`, a long random password (never used),
authentication _Web services authentication_ if enabled (otherwise manual), email a
team mailbox. No course enrolments.

## 3. Role "MCP read-only" (system context)

_Users → Permissions → Define roles → Add_: context type **System**, archetype none.
Allow only:

| Capability                                       | Why                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `webservice/rest:use`                            | Call the REST protocol                                                              |
| `moodle/course:view`                             | Access courses without being enrolled                                               |
| `moodle/course:viewparticipants`                 | `core_enrol_get_enrolled_users`, `core_enrol_get_users_courses`                     |
| `moodle/course:enrolreview`                      | `onlyactive` option                                                                 |
| `moodle/site:accessallgroups`                    | Courses in separate-groups mode                                                     |
| `moodle/user:viewdetails`                        | Profile fields of other users                                                       |
| `moodle/user:viewalldetails`                     | **[verify]** username / non-public profile fields                                   |
| `moodle/course:viewhiddenuserfields`             | Last-access when hidden by `hiddenuserfields`                                       |
| `moodle/category:viewhiddencategories`           | Category names when courses sit in hidden categories (staging: categories 3, 7)     |
| `report/progress:view`, `report/completion:view` | Others' progress/completion in `core_enrol_get_users_courses` (verified on staging) |
| `gradereport/user:view`, `moodle/grade:viewall`  | Optional: quiz grades for `avg_score`                                               |

Assign the role to `svc_mcp_readonly` at system level (_Assign system roles_).

Moodle's external-service page will still list "Missing capabilities" for this user. Leave
`moodle/user:update` (a **write** permission) and `moodle/course:useremail` (emails)
ungranted — the server never needs them. Grant `moodle/user:viewhiddendetails` only if
every Dealer comes back as never accessed.

## 4. External service

_Server → Web services → External services → Add_:
name `MCP read-only`, short name `mcp_readonly`, **Enabled**, **Authorised users only**,
no file up/download. Add exactly these functions (all read-only):

- `core_webservice_get_site_info`
- `core_course_get_categories`
- `core_course_get_courses_by_field`
- `core_enrol_get_enrolled_users`
- `core_user_get_users_by_field`
- `core_enrol_get_users_courses`
- `gradereport_user_get_grade_items` (optional, enables `avg_score`)

_Authorised users_ → add `svc_mcp_readonly`.

## 4b. Service-account prerequisites (otherwise every course call fails)

Moodle runs account checks when entering a course. Both of these surfaced on staging as
`errorcoursecontextnotvalid`; the server now reports Moodle's reason in the tool error.

1. **Required profile fields filled.** GLA has required custom fields (`level`,
   `Region_Dropdown`, `branch_code`, possibly more — see _Users → User profile fields_). Give
   the service account placeholder values (e.g. the UAT test values); leave
   `dealer_conso_id` empty unless required. Side effect: the GLA admin dashboard counts this
   account +1 in that branch/region.
2. **Site policy accepted.** _Users → Privacy and policies → User agreements_ → the service
   account → **Accept** on its behalf. **Repeat whenever a new policy version is published.**

Both, and everything above, must be redone after every staging refresh from production.

## 5. Token

_Server → Web services → Manage tokens → Create token_: user `svc_mcp_readonly`, service
`MCP read-only`, **Valid until** ~90 days (calendar a reminder), IP restriction empty
(Vercel egress IPs are not fixed).

Copy the token once into Vercel as `MOODLE_WS_TOKEN` (see `docs/DEPLOYMENT.md`). Do not
paste it into chat, tickets or the repo.

## 6. Verify

```bash
read -rs TOKEN
curl -s https://gla-staging.bihasa.ph/webservice/rest/server.php \
  --data-urlencode "wstoken=$TOKEN" -d wsfunction=core_webservice_get_site_info -d moodlewsrestformat=json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("username"), sorted(f["name"] for f in d.get("functions",[])))'
```

Expect `svc_mcp_readonly` and exactly the functions above (6, or 7 with the grade report).

## 7. Checks after (re)provisioning

1. In Claude: `describe_capabilities` — `lms_configured: true`, `avg_score.available` as expected.
2. `query_metrics` for one course — `population` shows learner accounts / valid dealers and
   `logged_in.count` is not 0 for everyone (otherwise last access is hidden from the role).
3. `get_person` for a known tester — `progress_pct` filled for courses they progressed in.

Verified on staging (2026-11-04): opening a course in the **mobile app** does not update
web course access; completing an activity in the app does move progress (0 → 25%).
