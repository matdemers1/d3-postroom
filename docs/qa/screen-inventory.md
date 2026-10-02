# Screen inventory: every screen × every state

PST-T-11.1 (PST-P-11), brought up to date by PST-T-16.25 (PST-P-16). Every route declared in
`apps/web/src/routes.ts` (the one table `App.tsx`, the navs, the tab titles and the ⌘K palette are all
built from), and the state each one shows when it has data, when it has none, while it waits, when
its data call fails, and when the person looking is not allowed to see it. Each ✅ is a check in
`e2e/tests/a11y.spec.ts`, and each one runs in the light and the dark theme, on the `desktop`
(1280×800) and `mobile` (390×844) Playwright projects. Every state is also checked by AxeBuilder with
the WCAG 2.0, 2.1 and 2.2 A and AA tags, which must report zero violations.

A third project, `landscape` (844×390, a phone on its side, touch), runs only the landscape suite of
`e2e/tests/mobile.spec.ts` (PST-T-16.18): the Inbox and an open message as the push layout with 44 px
targets and no sideways scroll, plus Account, Browser sessions and Calendar. It does not run
`a11y.spec.ts`, which asserts portrait geometry, so no row below has a landscape column.

Mailboxes are paths, not ids (PST-T-16.4, PST-REQ-198): `/mail/inbox`, `/mail/sent`, `/mail/drafts`,
`/mail/archive`, `/mail/trash`, `/mail/junk`, `/mail/rejects` and the sorter's folders
`/mail/updates`, `/mail/receipts`, `/mail/notifications`, `/mail/newsletters`. A folder you made
yourself has no slug and keeps its UUID, and a UUID in the path still works. `/` redirects to
`/mail/inbox` and keeps its query string.

## How each state is produced

| State | How the spec makes it | What counts as designed |
|-------|-----------------------|-------------------------|
| **Seeded** | Realistic data filed before the run: mail with an attachment, a Newsletters feed, a calendar event, a contact, an app password, a masked alias, a template, a failed job, a deferred outbound recipient, a hard-bounce suppression, and DMARC and TLS-RPT reports (swept in by the worker, which the stack must run) | The screen settles with no skeleton left in view, and `main` is not blank |
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
| Mail: inbox | `/mail/inbox` (`/` redirects here) | ✅ | ✅ *No messages here* | ✅ | ✅ | n/a | n/a | ✅ |
| Mail: mailbox list | `/mail` (below 768 px, the list of mailboxes) | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Mail: one message | `/mail/:mailbox/:messageId` (`:mailbox` is a slug or a UUID) | ✅ | n/a (one message) | ✅ | ✅ *Could not open this message* | n/a | n/a | ✅ |
| Mail: composer | `/mail/inbox?compose=new` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Mail: Newsletters feed | `/mail/newsletters` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Calendar | `/calendar` | ✅ | ✅ *Nothing scheduled* | ✅ | ✅ | n/a | n/a | ✅ |
| Contacts | `/contacts` | ✅ | ✅ *No contacts yet* | ✅ | ✅ | n/a | n/a | ✅ |
| Contacts: new contact | `/contacts/new` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Contacts: one contact | `/contacts/:addressBookId/:name` | ✅ | n/a (one card) | ✅ | ✅ | n/a | n/a | ✅ |
| Sender profile | `/senders/:address` | ✅ | ✅ *No messages from this sender yet* | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Account | `/settings/account` | ✅ | n/a (a form) | n/a | n/a | n/a | n/a | n/a |
| Settings: Connect a device | `/settings/security` | ✅ | n/a (static) | n/a | n/a | n/a | n/a | n/a |
| Settings: Browser sessions | `/settings/security/sessions` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Devices (app passwords) | `/settings/security/devices` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Addresses | `/settings/addresses` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Import | `/settings/import` | ✅ | ✅ the form alone (no history card) | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Rules & sorting | `/settings/rules` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Templates | `/settings/templates` | ✅ | ✅ | ✅ | ✅ | n/a | n/a | ✅ |
| Settings: Encryption keys | `/settings/keys` | — ² | — ² | — | — | n/a | n/a | — |
| Admin: Sign-in sessions | `/admin/sessions` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Sign in with D3 Auth | `/admin/sign-in` | ✅ | n/a (always has the connection values) | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Health | `/admin/health` | ✅ | ✅ *No health checks reported* | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Jobs | `/admin/jobs` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Outbound queue | `/admin/queue` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Suppressions | `/admin/suppressions` | ✅ | ✅ *No suppressed addresses* | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Deliverability | `/admin/deliverability` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: DNS & DKIM | `/admin/dns` | — ³ | — | — | — | — | — | — |
| Admin: Live SMTP | `/admin/smtp` | ✅ | ✅ | ✅ | ✅ | ✅ ¹ | ✅ | ✅ |
| Admin: Setup wizard | `/admin/setup` | — ³ | n/a (a form) | — | — | — | — | — |

¹ A non-admin who opens `/admin/*` sees the no-access state that `Shell.tsx` renders in place of the
screen. `redirectFor` in `apps/web/src/api.ts` used to send them back to the inbox without a word,
and that redirect is gone (1b2034a). The server still refuses every `/api/admin` call.

² Encryption keys is not in the `a11y.spec.ts` matrix. `e2e/tests/keys-empty-state.spec.ts` checks its
empty and populated lists, and `mobile.spec.ts` visits it at 390 px.

³ DNS & DKIM and the Setup wizard are not in the `a11y.spec.ts` matrix either. `e2e/tests/setup-wizard.spec.ts`
runs axe on both in the light and dark theme and checks they fit 390 px, with data present; their
empty, loading and error states are not asserted.

`n/a` means the state cannot happen on that screen. A form or a static page makes no data call, so
it has nothing to be empty of, wait for, or fail to load. A screen that is not under `/admin/` has
no admin gate. `—` means the state is not asserted for that screen (see the footnotes). `*` is any
other path: it redirects to `/mail/inbox`, which is the inbox row.

Every route above is declared once, in `apps/web/src/routes.ts` — its path, title, place (Mail,
Settings, Admin console), nav group, palette keywords and whether it is admin-only (PST-T-14.3). Two
labels differ from their screen's heading on purpose: the nav entry is *Security & devices* and its
three screens are *Connect a device* (`/settings/security`), *Browser sessions* and *Devices*; the
Admin console's *Sign-in sessions* lists every account's web sign-ins, while Settings' *Browser
sessions* lists yours.

The pre-14.3 URLs redirect to their new homes, which `e2e/tests/places.spec.ts` checks one by one:
`/app-passwords` and the old `/account/*` paths, `/account/sessions` → `/settings/security/sessions`,
`/account/device-setup` and `/settings/security/device-setup` → `/settings/security`, `/settings` →
`/settings/account`, and `/admin` → `/admin/health`. On a phone, `/settings` and `/admin` are instead
the place's index screen (the push stack's second level, PST-T-14.8), which `mobile.spec.ts` visits.

States that sit on a screen's URL rather than being a screen of their own: `?panel=inspect` opens the
Inspect drawer on an open message, `?q=` is the mail search, and `?compose=new|reply|replyall|forward|draft`
is the composer. The ⌘K palette is not a route; `command-palette.spec.ts` covers it.

## Before a session

| Screen | Route | Rendered | Error | Checked |
|--------|-------|:--------:|:-----:|---------|
| Sign in | `/signin` | ✅ | ✅ wrong password → alert | axe in both themes |
| Setup | `/setup` | ✅ | n/a | axe in both themes (the Gate is told setup is required; the screen is the real one) |
| Gate: server not answering | any route | ✅ *Could not reach the server* | ✅ `/api/auth/state` answers 500 | axe in both themes |
| Replace authenticator | any route, in place of the app (`reenrolRequired`, PST-T-16.26) | ✅ *Set up a new authenticator* | n/a | `account-security.spec.ts` (a recovery-code sign-in lands on it); not in the axe matrix |

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
(the usercontent origin) · PST-T-14.3 (the route table) · PST-T-16.4 (mailbox slugs) · PST-T-16.18
(the landscape project) · PST-T-16.25 (this update).
