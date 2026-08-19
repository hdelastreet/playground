# Security Brief — ScrumEstimate

Handoff brief for an agent picking up security work on this repo. Read this
before touching code; it records what the app is, what actually matters here,
and what has already been established so you don't re-derive it.

---

## 1. What the app is

A Planning Poker estimation tool. Static HTML/CSS/vanilla JS, no build step, no
backend of our own. All multi-user state lives in a **Firebase Realtime
Database** accessed directly from the browser via the compat SDK loaded from
`gstatic.com`.

Key files:

| File | Role |
| --- | --- |
| `js/firebase-core.js` | Firebase config, anonymous sign-in, session hand-off between pages |
| `js/setup.js` | The create and join forms: room creation and joining |
| `js/room.js` | Everything inside a room: live sync, voting, reveal |
| `pages/create.html` | Create-a-room form; loads the Firebase SDK |
| `pages/join.html` | Join-a-room form, prefilled from an invite link; loads the Firebase SDK |
| `pages/room.html` | The room itself; loads the Firebase SDK |
| `index.html` | Static landing page, no data access |
| `pages/results.html` | Placeholder, no data access |
| `README.md` | Firebase setup, data model, current rules |

Data model (also in `README.md`):

```
rooms/<CODE>/
  meta/ code, revealed, facilitatorUid, createdAt, lastActiveAt
  participants/<participantId>/
    id, name, ownerUid, hasVoted, connected, joinedAt
  votes/<participantId>: "<card value>"
```

*(This is the model as of the §7 work. It was previously flat — `code` and
`revealed` at the room root, with `isFacilitator` and `vote` on each
participant.)*

Room codes are 6 chars from a 32-char alphabet (~1.07e9 combinations).
Participant IDs are `Date.now()` base36 plus 6 random base36 chars — **not**
unguessable, and not secret anyway.

---

> **Status, 2026-08-19.** The findings in §3 have been addressed in code — see
> §7 at the bottom for what changed, what is still open, and the one console
> step that has to happen before any of it takes effect. §3 is left as written
> so the original analysis stays readable.

## 2. Threat model

Be proportionate. This is an internal team tool for sizing stories; there are no
passwords, payments, or personal data beyond **display names people type
themselves**. Treat these as the things worth protecting, in order:

1. **The Firebase project / billing account** — an open database on someone
   else's dime is the real exposure.
2. **Integrity of an estimation session** — votes not being readable before
   reveal, and non-facilitators not being able to reveal/reset/kick.
3. **Display names** — mild personal data, currently retained indefinitely.

Explicitly *not* in the threat model: nation-state attackers, side channels,
anything requiring the attacker to already control a participant's machine.

---

## 3. Established findings

Verified against the code at time of writing. Ordered by what I would fix first.

### 3.1 — The database is world-writable (critical)

There is **no authentication anywhere in the app**. For it to work at all, the
rules must grant public read and write on room nodes (see `README.md` → Firebase
setup). Consequences, all reachable with only the repo contents:

- Anyone can create unlimited rooms and write unlimited data → **denial of
  wallet** on the Firebase plan. There is no rate limiting of any kind.
- Anyone who knows a room code can delete the room, wipe participants, or
  rewrite anyone's vote.
- There are **no `.validate` rules**, so field types, field names, and payload
  sizes are unconstrained. The `maxlength="40"` on the name inputs
  (`pages/room.html:33`, `:42`) is a client-side hint only.

Direction: Firebase **Anonymous Auth** is the natural fit — it needs no login UI,
gives every client a real `auth.uid`, and lets rules be written in terms of it.
That is the single change that unlocks fixing 3.2 and 3.3 properly. It does
require enabling a sign-in provider in the Firebase console (a human step).

### 3.2 — Facilitator privilege is client-side only (high)

`isFacilitator` is a plain boolean in the database, set at
`js/room.js:138` and `js/room.js:180`. Every privileged path checks it **in the
browser**:

- `revealVotes()` — `js/room.js:202`
- `newRound()` — `js/room.js:206`
- `kickParticipant()` — `js/room.js:216`
- room deletion on facilitator leave — `js/room.js:234`

The UI hides these controls from non-facilitators (`js/room.js:326`), but nothing
stops a participant from calling the functions from the console, or simply
writing `isFacilitator: true` onto their own node. Whoever fixes this needs
rules that pin the facilitator to a specific identity — which requires 3.1 first.

### 3.3 — Votes are readable before reveal (high, and it defeats the feature)

`vote(value)` writes the vote straight to the database (`js/room.js:190`).
`revealed` only gates **rendering** (`js/room.js:296`-`300`). Any participant with
devtools open can read everyone's vote before reveal — which is exactly the
anchoring bias the hide-until-reveal mechanic exists to prevent.

Direction: this cannot be fixed by rules alone while all clients need to read the
participant list. Options worth weighing: move votes to a sibling node whose
`.read` is gated on `revealed === true`, or have clients submit a hash commitment
pre-reveal. The first is far simpler and probably enough for an internal tool.

### 3.4 — No retention or cleanup of abandoned rooms (medium)

A room is only deleted when the facilitator explicitly leaves
(`js/room.js:234`). If they just close the tab, `onDisconnect` marks them
`connected: false` but the room persists forever, holding participant names.
There is no TTL, no scheduled cleanup, and no way for a participant to delete
their own data. Also unbounded growth on the database.

### 3.5 — Third-party script loaded without integrity pinning (low)

`pages/room.html:105`-`106` loads two Firebase scripts from `gstatic.com`. The
version is pinned (`10.14.1`), which is good, but there is no `integrity`
attribute and no `crossorigin`. Low likelihood given the host, but it is a
cheap hardening.

### 3.6 — Already handled; do not "fix" these

Check before changing — these are correct as-is:

- **HTML escaping.** `escHtml()` (`js/room.js:50`) escapes the five dangerous
  characters and is applied to every untrusted interpolation in the `innerHTML`
  templates (`js/room.js:298`, `:308`, `:312`, `:362`). The one attribute
  interpolation (`data-id`) sits inside double quotes and the escaper covers
  quotes. I found no XSS path. Don't rip out the templates for a DOM-building
  refactor on security grounds alone.
- **The committed `apiKey`** (`js/room.js:6`-`14`). A Firebase web API key is a
  public project identifier, not a credential — it is *designed* to ship in
  client code. Rotating it accomplishes nothing on its own. The open rules (3.1)
  are the actual issue. Don't file this as "secret leaked in git".
- **Room code entropy.** ~1.07e9 codes, and the documented rules grant `.read` at
  `rooms/$code`, not at `rooms`, so the room list cannot be enumerated. Codes are
  adequate. *But* if the database is still on console "test mode" rules
  (root-level `.read: true`), enumeration is trivial — verify which rules are
  actually deployed before concluding anything here.

---

## 4. Constraints — do not break these

- **No build step.** Pure static files. Do not introduce npm, a bundler, or a
  transpiler.
- **No backend of our own.** Firebase rules and console config are the only
  server-side surface available. Cloud Functions would be a new dependency and a
  new cost — get sign-off before proposing them.
- **It must keep working when `index.html` is opened directly** (`file://`), as
  documented in `README.md`.
- **Rules changes are a human step.** You can write the rules JSON into the repo
  and document it, but you cannot deploy it — say so explicitly rather than
  implying it is live.
- Don't touch visual design; a separate design-system pass owns `css/style.css`
  and `ui-guidelines.md`.

---

## 5. Decisions needed from the repo owner

Don't guess these — they change the shape of the fix:

1. **Is Anonymous Auth acceptable?** It is the unlock for 3.1–3.3 and needs a
   console change. If not, the ceiling on hardening is much lower.
2. **Should rooms be private?** Right now, knowing the code is the only gate. If
   rooms should be restricted to a known set of people, that is a different
   design, not a rules tweak.
3. **Retention policy for abandoned rooms** — pick a TTL (24h? 7d?) and decide
   who enforces it.
4. **Is the current Firebase project shared or disposable?** Determines how
   urgent the denial-of-wallet risk in 3.1 actually is.

---

## 6. Out of scope

`pages/results.html` is an unimplemented placeholder — nothing to review. The
former `steps-to-build.html` was an internal doc, has been deleted, and is not
coming back.

---

## 7. Status — 2026-08-19

Decisions taken by the repo owner: Anonymous Auth **yes**, provided it adds no
step for an honest user (it doesn't — no UI, sign-in fires on page load). TTL
**24h**. Project is disposable, but the app will be linked from a public
portfolio, so **staying small enough never to be billed** is a hard requirement.

New file: `database.rules.json`. Data model changed — see `README.md`.

| Finding | State | How |
| --- | --- | --- |
| 3.1 world-writable | **Fixed, verified live** | Anonymous Auth + full rule set. `auth != null` everywhere, `.validate` on every field, unknown keys rejected, and `rooms` readable only through one query-gated exception (§ *Sweeping the room list* below) so live codes can't be enumerated. |
| 3.2 client-side facilitator | **Fixed, verified live** | `isFacilitator` deleted from the data model. The host is whoever matches `meta/facilitatorUid`, written once at creation and frozen by rule. Reveal / new round / kick / delete are all checked against it server-side. |
| 3.3 votes readable early | **Fixed, verified live** | Votes moved to `rooms/<CODE>/votes/<pid>`, readable only when `revealed === true`; before that the rules grant each client read on exactly their own vote. Required splitting the single room listener into three, since read permission cascades downward. |
| 3.4 no retention | **Fixed, verified live** (sweep unverified) | 24h TTL on `meta/lastActiveAt`, which rules force to equal the server clock. Any client that meets an expired room deletes it, and the create page now actively sweeps them — see § *Sweeping the room list*. |
| 3.5 no SRI | **Fixed, live** | `integrity` + `crossorigin` on all three SDK scripts, on every page that loads them (`pages/create.html`, `pages/join.html`, `pages/room.html`). Hashes computed from the actual 10.14.1 files. Bumping the version means recomputing them, and adding a page that loads the SDK means carrying the attributes over. |
| 3.6 don't-fix list | Untouched | `escHtml()` and its call sites are unchanged; the `apiKey` is unchanged. |

### Verification

The rules were published by the owner and then exercised against the live
database over the REST API, driving two real anonymous identities (a facilitator
and an ordinary participant) through the full flow. **37 checks, all behaving as
intended**, covering: unauthenticated access, room enumeration, room-code shape,
required and unknown fields, name length, participant-id shape, `ownerUid` and
`id` forging, seizing `facilitatorUid` (denied even to the current host),
non-card and oversized vote values, voting on someone else's behalf, votes for
non-existent participants, reading votes before reveal (denied to the
facilitator too), changing a vote after reveal, non-facilitator reveal / kick /
delete, and back- and post-dating `lastActiveAt`.

Two things that behave as designed and are worth knowing rather than
rediscovering:

- **The facilitator can write another participant's vote.** This falls out of
  the cascading room-level write they need in order to clear every vote on a new
  round. Rules cannot grant "delete all votes" without granting "write a vote".
  Accepted: the host can already reveal and reset at will, and reading votes
  early is still denied to them.
- **`facilitatorUid` is frozen against everyone, including the facilitator.**
  There is deliberately no host hand-off. If that is ever wanted it is a rule
  change, not just a UI one.

### Sweeping the room list

Finding 3.4 was only half solved. The TTL was enforced, but collection fired
only when someone re-entered an expired room, and nobody re-enters a finished
meeting room: the tab closes and the code is never typed again. In practice
every room ever created stayed in the database.

Fixing it without a backend needed a way to *find* stale rooms, which meant
reading the room list — the thing deliberately left unreadable. The compromise
is a `.read` on `rooms` gated on the query itself:

```
".read": "auth != null && query.orderByChild === 'meta/lastActiveAt'
          && query.endAt > 0 && query.endAt <= now - 86400000
          && query.limitToFirst > 0 && query.limitToFirst <= 25"
```

`sweepAbandonedRooms()` (`js/firebase-core.js`) runs exactly that query on
create-page load and deletes what comes back. Why this is safe to grant:

- **It cannot reach a live room.** The bounds are compared against `now` — the
  server clock — so the window cannot be widened from the client, and
  `lastActiveAt` can only ever be written as `now`. A room in use is outside the
  range. Independently, the delete is still gated by the pre-existing
  stale-delete branch, which re-checks the 24h threshold server-side; a
  hand-crafted `remove()` on a guessed code is refused exactly as before.
- **It grants nothing beyond that query.** Read permission cascades, but this
  expression is only ever true for a query of this shape. A plain read of
  `rooms/<CODE>/votes` sets no query parameters, so `query.orderByChild` is null,
  the expression is false, and the deeper rules decide as they did before.
- **Concurrent sweeps are harmless.** Two teams creating rooms at the same moment
  fetch the same list and both delete it; `remove()` on an already-deleted path
  is a no-op.
- **Each `> 0` is load-bearing.** Without them an unset parameter would be
  compared as null, which is not worth trusting: they pin `endAt` and
  `limitToFirst` to actual numbers so the query cannot be run unbounded.

**The cost, accepted:** any signed-in browser can now read the full contents of
rooms already past the TTL — participant names and revealed or unrevealed votes
included — for as long as it takes the next sweep to delete them. That is
abandoned data on its way out, and the estimates in it are minutes on a story
nobody is discussing any more. Live rooms are unaffected. If that ever stops
being acceptable, the alternative is a scheduled job, which means a backend and
a billing account.

The client's 5-minute margin (`SWEEP_CLOCK_MARGIN_MS`) exists because a browser
clock running fast would push `endAt` past the window the rules allow and get the
sweep denied. `SWEEP_BATCH` must stay at or below the rules' `limitToFirst`
ceiling for the same reason.

### Not done / still open

- **The stale-delete branch has only been tested negatively.** Deleting a *fresh*
  room is correctly denied, and `lastActiveAt` cannot be back- or post-dated —
  but a genuinely >24h-old room could not be manufactured to test the positive
  case, precisely because the rules force that field to the server clock. To
  confirm it for real: temporarily drop the `86400000` in the console rules to
  `60000`, leave a room for a minute, load it, and check it is collected — then
  put it back.
- **No cap on participants per room.** Realtime Database rules cannot count
  children. Someone with a room code can add participants without limit. The
  per-node size limits bound how fast, not whether.
- **No cap on room creation.** Nothing stops a script minting rooms under random
  codes. The 24h TTL keeps them from accumulating forever, and the free plan is
  the actual backstop against a bill — hence "stay on Spark".
- **Collection still depends on someone using the app.** The create-page sweep
  fires on the next room anyone creates, which for a team that estimates weekly
  means garbage lives days, not forever — but a project that goes quiet keeps
  whatever was in it at the end. Bounded storage, not guaranteed erasure. Only a
  scheduled job gives that, and it needs a backend.
- **The sweep itself is unverified.** The 37 REST checks predate it. The rules it
  relies on have not been exercised: neither that the permitted query is accepted
  nor — more importantly — that a query with widened bounds is *denied*. Worth
  running before trusting it, alongside the positive stale-delete case above,
  since both need the same manufactured old room.
- **The client has never been loaded in a browser.** The *rules* are verified;
  `js/room.js` is not. No browser was available here, so the three-listener
  rewrite, the reveal/reset round trip and the session-restore path have been
  reasoned about but not watched running.
- **Watch out for the API key's referrer allowlist.** The Realtime Database
  ignores the API key entirely, so a restricted key breaks nothing until
  something calls the *auth* API — which is exactly what this work added. It
  presents as a total outage that looks like a rules problem and is not. See the
  troubleshooting section in `README.md`. Currently only `http://localhost:3000`
  is allowed; the portfolio domain will need adding at deploy time.
- **`file://` is unverified.** Anonymous sign-in is a plain HTTPS call to the
  Identity Toolkit and should be fine from a `null` origin, but auth persistence
  leans on storage that browsers restrict on `file://`. Expect refresh-restore
  to degrade there (you rejoin as a new participant) even if signing in works.
