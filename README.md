# Playground — Scrum Estimation App

A Planning Poker web app for estimating user stories with a scrum team. Everyone
opens the same room code from their own machine and votes simultaneously; votes
stay hidden until the facilitator reveals them.

## Run locally

Open `index.html` in your browser — there is no build step and no local server to
run. (Any static server, e.g. `npx serve .`, also works if you prefer `http://`
over `file://`.)

Real-time sync between participants goes through Firebase Realtime Database, so
the app needs network access and a configured Firebase project — see below.

## Stack

- Pure HTML / CSS / Vanilla JS — no framework, no build step
- Firebase Realtime Database (compat SDK, loaded from CDN) for multi-user sync
- `sessionStorage` to reconnect the same participant after a page refresh

## Firebase setup

The app ships with a working Firebase project, so it runs as-is. To point it at
your own project instead:

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. **Build → Realtime Database → Create Database.** Pick a region. The starting
   rules do not matter — you replace them in step 6.
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
   The app signs in anonymously as the page loads: there is no login screen and
   nothing for a user to click, but every read and write is rejected if this
   provider is off.
4. **Project settings → General → Your apps → Web app** (`</>`), register the app,
   and copy the generated `firebaseConfig` object.
5. Paste those values over `FIREBASE_CONFIG` at the top of `js/firebase-core.js`. Make sure
   `databaseURL` is included — the Realtime Database will not connect without it.
6. **Build → Realtime Database → Rules**, paste the contents of
   `database.rules.json`, and publish. (That file carries `//` comments, which
   Firebase's rules parser accepts — the console's own default rules ship with
   one — but a strict JSON linter will not.)

If you already had an older version of these rules published, republish them:
reactions live at a node that did not exist before, and every write to it is
refused until the new rules land.

The `apiKey` in `js/firebase-core.js` is a public client identifier, not a secret — it is
designed to ship in client code. `database.rules.json` is what actually governs
access.

### Recommended console settings

Worth doing if the app is reachable by people you don't know:

- Stay on the **Spark (free) plan.** With no billing account attached, exhausting
  a quota stops the database rather than producing a bill.
- **Authentication → Settings → User account management:** enable automatic
  clean-up of anonymous accounts, so sign-ins from one-off visitors are deleted
  after 30 days rather than accumulating.
- **Authentication → Settings → Authorized domains:** trim it to the domains you
  actually serve the app from.

### If nothing works: check the API key's referrer restrictions

Symptom: every action fails, the app reports **"This origin is not on the API
key's allowed-referrer list"**, and the browser console shows
`API_KEY_HTTP_REFERRER_BLOCKED`.

The Realtime Database ignores the API key entirely — it authorises by
`databaseURL` plus rules — so a restricted key causes no trouble at all until
something calls the **auth** API. Adding anonymous sign-in is what makes it
bite, which makes it easy to misread as a broken security rule.

Fix it in the **Google Cloud** console (not the Firebase one):
APIs & Services → Credentials → *Browser key (auto created by Firebase)* →
Application restrictions. Either set it to **None**, or keep *Websites* and add
every origin you serve from — including the local one:

```
http://localhost:3000/*
https://<your-portfolio-domain>/*
https://estimateroom-97b7b.firebaseapp.com/*
```

Changes can take a few minutes to propagate. Note this is a *different* setting
from Firebase Authentication → Settings → Authorized domains, which governs
redirect-based sign-in and is not what anonymous sign-in checks.

### What the rules enforce

| Rule | Effect |
| --- | --- |
| Everything requires `auth != null` | Anonymous sign-in is the floor; unauthenticated clients get nothing. |
| `rooms` is unreadable but for one query | Live room codes cannot be enumerated; the single permitted query returns only rooms already past the TTL, which is what lets the create page collect them. |
| `meta/facilitatorUid` is frozen on creation | Reveal, new round, kick and room deletion are checked against it, so the host role cannot be granted to yourself. |
| `participants/<id>/ownerUid` is frozen on first write | You can only write your own participant node — no editing or deleting anyone else's. |
| `votes` is readable only once `revealed` is true | Before reveal each client can read exactly one vote: their own. |
| Field-by-field `.validate` | Names ≤ 40 chars, votes restricted to the card values, unknown keys rejected outright — a client cannot inflate the database with arbitrary payloads. |
| `meta/lastActiveAt` must equal the server clock | It can be neither backdated to force a delete nor forged to outlive the TTL. |
| `reactions/<id>` is own-slot only, and rate-limited | The one rate limit in the file: `at` is pinned to the server clock, so each new reaction must be at least 1.2s past the previous one. |

Two things the rules genuinely cannot do, both inherent to Realtime Database:
there is no way to count children, so **the number of participants in a room is
not capped**; and nothing stops a script from creating many rooms with random
codes. The 24h TTL below and the free-plan ceiling are what bound both.

## Data model

One node per room, keyed by room code:

```
rooms/
  ABC123/
    meta/
      code:           "ABC123"
      revealed:       false
      facilitatorUid: "<auth uid of the host>"
      createdAt, lastActiveAt
    participants/
      <participantId>/
        id, name, ownerUid, hasVoted, connected, joinedAt
    votes/
      <participantId>: "8"
    reactions/
      <senderParticipantId>/
        kind: "agree"
        to:   "<participantId the reaction is aimed at>"
        at:   <server timestamp>
```

- Room codes are 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` —
  no `I`, `O`, `0` or `1`, so codes are unambiguous when read aloud.
- **Votes live outside the participant list** so they can be hidden properly.
  Until `revealed` flips to true, the rules let each client read exactly one
  vote — their own. `hasVoted` stays on the participant node, which is all the
  "Voted / Waiting…" badge needs. Hiding before reveal is enforced by the rules,
  not just by the UI.
- **Nobody is a facilitator by flag.** The host is whoever's `auth.uid` matches
  `meta/facilitatorUid`, which is set once at room creation and immutable
  thereafter. The client derives the badge and the controls from it; the rules
  check it on every privileged write.
- `ownerUid` ties a participant node to the browser that created it, so one
  participant cannot rewrite or delete another.
- `connected` is driven by `.info/connected`, not written once at join. Every
  time the socket comes back the room page re-arms the `onDisconnect` hook and
  re-asserts `connected: true` — the hook is one-shot, and a backgrounded tab
  drops its connection often enough that a flag written once would stick at
  *offline* for the rest of the meeting. A closed tab shows up as *offline*
  rather than vanishing.
- When the facilitator leaves, the whole room node is deleted and every
  participant is sent back to the join page, which says the room was closed.
- **A reaction is a write, not a message.** One slot per sender holds only their
  most recent one; each client animates an arrival for about two seconds and then
  forgets it, and nothing is ever written to end one. A reaction older than that
  window is ignored on arrival, which is also what stops a refresh or a reconnect
  replaying the ones that came before. Reactions deliberately do **not** stamp
  `lastActiveAt`: heckling is not estimating, and a distracted room should still
  age out on schedule.

### Changing the reaction set

Edit the `REACTIONS` array at the top of the reactions section in `js/room.js` —
that is the whole change. Each entry is a `kind` (lowercase, ≤16 chars), the
`emoji` that lands on someone's row, a `label` used for the tooltip and for
screen readers, and a Lucide `icon` path for the button.

Nothing else needs touching, and in particular **no rules change and no console
publish**. The rules validate `kind` by shape rather than by listing the values
the way vote faces are listed, precisely so the set stays editable; clients look
each kind up in their own table and render nothing on a miss, so a value a client
has never heard of is ignored rather than breaking it. That also means a browser
left open on an older version simply won't show a newly added reaction.

### Retention

Rooms expire **24 hours after their last activity**. Every join, vote, reveal
and reset stamps `meta/lastActiveAt` with the server clock; any client that
later encounters a room past the threshold deletes it, and the rules permit that
delete from anyone once the room is genuinely stale.

Nobody re-enters a finished meeting room, though, so that on-the-way-past
collection would never fire on its own. **The create page sweeps.** On load it
runs the one query the rules allow against the room list — the 25 oldest rooms
whose `lastActiveAt` is already past the TTL — and deletes what comes back
(`sweepAbandonedRooms()`, `js/firebase-core.js`). Starting a meeting is what
collects the rooms the last meetings left behind, so nothing accumulates for
longer than about a day and there is still no scheduled job and no backend.

A room in use cannot be caught by this, for two separate reasons: an active room
is not in the query's range at all, and the delete would be refused by the rules
even if it were, since they re-check the 24h threshold against the server clock.
Teams in different rooms never touch each other's data.

Change the window in both `ROOM_TTL_MS` (`js/firebase-core.js`) and the two
`86400000` values in `database.rules.json` — the stale-delete branch and the
query-gated `.read` — they all have to agree.

## Getting into a room

Three pages, one job each:

| Page | Reached from | Asks for |
| --- | --- | --- |
| `pages/create.html` | "Create a room" on the home page | your name |
| `pages/join.html` | "Join a room", or an invite link | your name, and the code — prefilled when it came from a link |
| `pages/room.html` | either of the above, or a refresh | nothing |

Creating and joining used to share one screen with a tab switcher, which was
worst for the people it mattered most for: someone following an invite link
landed on a form that also offered to create a room, with the room they were
actually invited to one wrong tab away. Each entry path is now its own page,
with a quiet link to the other at the foot of the card.

The room page has no form at all. Both entry pages do their own Firebase write —
which is what keeps "Room not found" next to the input that caused it — then save
the session and navigate. `pages/room.html` picks that session up exactly the way
it does after a refresh, so there is one way into a room rather than two. Finding
no usable session, it sends you to `pages/join.html` with a note saying why: the
room was closed, it expired, or you were removed from it.

Invite links are `pages/join.html?roomId=CODE`, which the Share button in the
room copies. Old `pages/room.html?join=true&roomId=CODE` links still work — the
room page forwards them.

## Project structure

```
index.html            Landing page — one button per entry path
pages/create.html     Create a room (name only; you become the facilitator)
pages/join.html       Join a room (code prefilled when you follow an invite link)
pages/room.html       The room itself: card deck, votes, results, reactions
pages/results.html    Placeholder — session history and export are not built yet
css/style.css         All styles
js/firebase-core.js   Firebase config, anonymous auth, session hand-off
js/setup.js           The create and join forms
js/room.js            Room logic and live sync
database.rules.json   Realtime Database security rules — paste into the console
SECURITY-BRIEF.md     Threat model and findings
ui-guidelines.md      Visual design system — applied to style.css
```
