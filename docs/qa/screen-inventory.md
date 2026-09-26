# Screen inventory: every screen × every state

PST-T-11.1 (PST-P-11). Every route in `apps/web/src/App.tsx`, and the state each one shows when it
has data, when it has none, while it waits, when its data call fails, and when the person looking
is not allowed to see it. Each ✅ is a check in `e2e/tests/a11y.spec.ts`, and each one runs in the
light and the dark theme, on the `desktop` (1280×800) and `mobile` (390×844) Playwright projects.
Every state is also checked by AxeBuilder with the WCAG 2.0, 2.1 and 2.2 A and AA tags, which must
report zero violations.

## How each state is produced

| State | How the spec makes it | What counts as designed |
|-------|-----------------------|-------------------------|
| **Seeded** | Realistic data filed before the run: mail with an attachment, a Newsletters feed, a calendar event, a contact, an app password, a masked alias, a template, a failed job, a deferred outbound recipient, and DMARC and TLS-RPT reports (swept in by the worker, which the stack must run) | The screen settles with no skeleton left in view, and `main` is not blank |
| **Empty** | The screen's own data call gets the real response with its collections emptied (route interception over `route.fetch()`) | An `EmptyState` inside `main` that says what is missing and, where there is one, what to do about it |
| **Loading** | The data call is held until the spec releases it | A visible skeleton or spinner inside an element with an accessible name (`role="status"` or `aria-busy` with `aria-label`), never a blank area. Once released, the screen settles and is checked by axe (*loading-complete*) |
| **Error** | The data call answers `500 {"error":"internal_error"}` | `EmptyState kind="error"` (or an alert) with *Try again*, and no raw code, status or `undefined` anywhere on the page |
| **Denied: not an admin** | `/api/auth/state` answers `isAdmin: false` and every `/api/admin/*` call answers 403, which is what the server does for a non-admin session | `EmptyState kind="no-access"` in place of the admin screen. The admin links are gone from the navigation |
| **Denied: role withdrawn** | The page still holds an admin's auth state, but every `/api/admin/*` call answers 403 (the role was taken away while the page was open) | `EmptyState kind="no-access"`, *You do not have access to this*, from each admin screen's own load |
| **Denied: session ended** | Signed in on a screen that loads nothing, the session cookie is cleared, then the app navigates client-side to the screen. The real server answers its fetch with 401 | `EmptyState kind="no-access"`, *Your session has ended*, with a *Sign in again* link |

> [!note] Why the non-admin case is simulated
> Postroom can create a second human account only through D3 Auth's OIDC flow, which the e2e stack
> points at a closed port on purpose. A new-account API would be a feature of its own. Until one
> exists, the spec gives the browser what a non-admin session gets from the server: `isAdmin: false`
> in the auth state and 403 from every admin route.

## Signed-in screens

| Screen | Route | Seeded | Empty | Loading → complete | Error (500) | Denied: not admin | Denied: role withdrawn | Denied: session ended |
|--------|-------|:------:|:-----:|:------------------:|:-----------:|:-----------------:|:----------------------:|:---------------------:|
| Mail: inbox | `/` | ✅ | ✅ *No messages here* | ✅ | ✅ | n/a | n/a | ✅ |
| Mail: mailbox list | `/mail` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Mail: one message | `/mail/:mailboxId/:messageId` | ✅ | n/a (one message) | ✅ | ✅ *Could not open this message* | n/a | n/a | ✅ |
| Mail: composer | `/?compose=new` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Mail: Newsletters feed | `/mail/:newslettersId` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Calendar | `/calendar` | ✅ | ✅ *Nothing scheduled* | ✅ | ✅ | n/a | n/a | ✅ |
| Contacts | `/contacts` | ✅ | ✅ *No contacts yet* | ✅ | ✅ | n/a | n/a | ✅ |
| Contacts: new contact | `/contacts/new` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Contacts: one contact | `/contacts/:addressBookId/:name` | ✅ | n/a (one card) | ✅ | ✅ | n/a | n/a | ✅ |
| Sender profile | `/senders/:address` | ✅ | ✅ *No messages from this sender yet* | ✅ | ✅ | n/a | n/a | ✅ |
| App passwords | `/app-passwords` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Masked aliases | `/account/aliases` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Change password | `/account/password` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Devices | `/account/sessions` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Import mail | `/account/import` | ✅ | ✅ *No imports yet* | ✅ | ✅ | n/a | n/a | ✅ |
| Set up iPhone / Mac | `/account/device-setup` | ✅ | n/a (static) | n/a | n/a | n/a | n/a | n/a |
| Rules | `/account/rules` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Compose templates | `/account/templates` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Admin: Sessions | `/admin/sessions` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Health | `/admin/health` | ✅ | ✅ *No health checks reported* | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Jobs | `/admin/jobs` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Outbound queue | `/admin/queue` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Deliverability | `/admin/deliverability` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: SMTP sessions | `/admin/smtp` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |

¹ A non-admin who opens `/admin/*` sees the no-access state that `Shell.tsx` renders in place of the
screen. `redirectFor` in `apps/web/src/api.ts` used to send them back to the inbox without a word,
and that redirect is gone (1b2034a). The server still refuses every `/api/admin` call.

`n/a` means the state cannot happen on that screen. A form or a static page makes no data call, so
it has nothing to be empty of, wait for, or fail to load. A screen that is not under `/admin/` has
no admin gate. `*` is any other path: it redirects to `/`, which is the inbox row.

## Before a session

| Screen | Route | Rendered | Error | Checked |
|--------|-------|:--------:|:-----:|---------|
| Sign in | `/signin` | ✅ | ✅ wrong password → alert | axe in both themes |
| Setup | `/setup` | ✅ | n/a | axe in both themes (the Gate is told setup is required; the screen is the real one) |
| Gate: server not answering | any route | ✅ *Could not reach the server* | ✅ `/api/auth/state` answers 500 | axe in both themes |

## Where the states live

- `apps/web/src/screens/states.tsx` holds `Loading`, `LoadFailed`, `SessionEnded` and `NoAccess`,
  which every data screen shares. A bare `<Skeleton variant="block" />` has no height, which left
  every one of these screens blank while it loaded. `Loading` gives the skeleton a height and puts
  it inside a named `role="status"`.
- `apps/web/src/screens/Shell.tsx` renders `NoAccess` in place of any `/admin/*` screen for an
  account that is not an admin.
- The mail list and the reading pane (`apps/web/src/mail/MailView.tsx`, `ReadingPane.tsx`) show
  `SessionEnded` when their call answers 401.

## What axe does not look inside

A message's own HTML renders in a sandboxed `<iframe>` on the usercontent origin with scripts turned
off (PST-T-3.12). axe cannot run inside it, and its markup belongs to the sender rather than to
Postroom. So the spec excludes `iframe[data-testid="message-html"]` from the axe run and checks
separately that every such frame has a `title`. No axe rule is disabled.

## Related

PST-P-11 · PST-T-11.1 · PST-T-11.2 (the 390 px pass, `e2e/tests/mobile.spec.ts`) · PST-T-3.12
(the usercontent origin).
