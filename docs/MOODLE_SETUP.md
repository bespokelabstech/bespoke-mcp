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

| Capability                                       | Why                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `webservice/rest:use`                            | Call the REST protocol                                                          |
| `moodle/course:view`                             | Access courses without being enrolled                                           |
| `moodle/course:viewparticipants`                 | `core_enrol_get_enrolled_users`, `core_enrol_get_users_courses`                 |
| `moodle/course:enrolreview`                      | `onlyactive` option                                                             |
| `moodle/site:accessallgroups`                    | Courses in separate-groups mode                                                 |
| `moodle/user:viewdetails`                        | Profile fields of other users                                                   |
| `moodle/user:viewalldetails`                     | **[verify]** username / non-public profile fields                               |
| `moodle/course:viewhiddenuserfields`             | Last-access when hidden by `hiddenuserfields`                                   |
| `moodle/category:viewhiddencategories`           | Category names when courses sit in hidden categories (staging: categories 3, 7) |
| `report/progress:view`, `report/completion:view` | **[verify]** others' progress/completion in `core_enrol_get_users_courses`      |

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

_Authorised users_ → add `svc_mcp_readonly`.

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

Expect `svc_mcp_readonly` and exactly the six functions above.

## 7. Day-1 checks on staging

1. Open a Course in the **mobile app** as a UAT tester, then check that tester's last access
   via `get_course_access` (does the app update `lastcourseaccess`?).
2. Time a full `get_access_summary` across all Courses (logs: `tool.ok` → `ms`,
   `upstream_calls`). If it hits `scope_too_large`, lower `maxCoursesPerRequest` or raise
   `participantsPageSize` in the tenant config.
3. Confirm `level`, `Region_Dropdown`, `branch_code`, `dealer_conso_id` come back populated
   (profile field visibility for the service role).
4. `get_dealer_access` for a UAT tester: are `progress_pct` / `completed` filled?
