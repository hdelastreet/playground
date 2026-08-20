// room.js — the estimation room itself: live sync, voting, reveal, results.
//
// This page assumes you are already in a room. Getting in is create.html /
// join.html's job (see setup.js); this file only ever restores the session those
// pages wrote — the same path a refresh takes. Anyone arriving without one is
// sent to the join page, with a notice saying why if we know.
//
// Access control lives in database.rules.json, not in this file. Everything the
// browser does here is assumed to be forgeable; the rules are what actually
// enforce "only the facilitator reveals" and "nobody reads a vote early".

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];

const HOME_PAGE = '../index.html';
const JOIN_PAGE = 'join.html';

let leavingIntentionally = false;

// Live room state, assembled from several listeners (see subscribeToRoom)
let roomMeta = null;
let roomParticipants = [];
let participantsLoaded = false;
let roomVotes = {};           // only populated once votes are revealed
let myVote = null;            // our own vote, readable before reveal

// Real-time subscription
//
// The room is read through three separate listeners rather than one on
// `rooms/<code>`, because read permission in Firebase cascades downward: a
// single listener that high would carry read access to the votes with it, which
// is exactly what has to stay closed until reveal.

let roomListeners = [];
let votesRef = null;
let votesCb = null;

// Whether we currently *want* to be reading the vote list, tracked separately
// from whether we hold a listener on it. A denied read must not be what decides
// that question — see syncVotesListener.
let votesWanted = false;
let votesRetryTimer = null;
let votesRetries = 0;

const VOTES_RETRY_BASE_MS = 300;
const VOTES_RETRY_MAX = 6;     // ~19s of backoff in total before we stop asking

// `event` defaults to 'value'; the reactions feed passes child_added/child_changed,
// because there it is each individual arrival that matters rather than the state of
// the collection.
function listen(ref, cb, errCb, event) {
  const type = event || 'value';
  const bound = ref.on(type, cb, errCb || (() => {}));
  roomListeners.push({ ref, cb: bound, type });
}

function detachVotesListener() {
  if (votesRef) { votesRef.off('value', votesCb); votesRef = null; votesCb = null; }
}

function cancelVotesRetry() {
  clearTimeout(votesRetryTimer);
  votesRetryTimer = null;
  votesRetries = 0;
}

function detachRoomListeners() {
  roomListeners.forEach(({ ref, cb, type }) => ref.off(type, cb));
  roomListeners = [];
  votesWanted = false;
  cancelVotesRetry();
  detachVotesListener();
  clearReactions();
}

function subscribeToRoom(code) {
  detachRoomListeners();
  roomMeta = null;
  roomParticipants = [];
  participantsLoaded = false;
  roomVotes = {};
  myVote = null;

  listen(rRef(`rooms/${code}/meta`), snap => {
    const meta = snap.val();
    if (!meta) { handleRoomClosed(); return; }
    roomMeta = meta;
    syncVotesListener(code, !!meta.revealed);
    renderIfReady();
  });

  listen(rRef(`rooms/${code}/participants`), snap => {
    const raw = snap.val();
    roomParticipants = Object.values(raw || {})
      .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    participantsLoaded = true;

    // An empty participants node means the room is being torn down; let the
    // meta listener report that instead, so we don't cry "kicked" on shutdown.
    if (raw && !roomParticipants.some(p => p.id === currentParticipantId) && !leavingIntentionally) {
      handleRemoved('removed');
      return;
    }
    renderIfReady();
  });

  // Our own vote. Readable before reveal because the rules grant read on
  // exactly this one child to its owner — everyone else's stays closed.
  listen(rRef(`rooms/${code}/votes/${currentParticipantId}`), snap => {
    myVote = snap.val();
    renderIfReady();
  });

  // Reactions, per arrival rather than per state. A 'value' listener would give
  // us the whole collection and no way to tell which entry just changed, and the
  // same reaction sent twice would look identical — the server timestamp is what
  // makes every write a distinct event.
  //
  // Always attached, even for someone who never opens the reaction bar: receiving
  // is what makes the feature discoverable at all, and an idle listener carries no
  // traffic. Whether *you* can send is the toggle's business.
  const reactionsRef = rRef(`rooms/${code}/reactions`);
  const onReaction = snap => receiveReaction(snap.val());
  listen(reactionsRef, onReaction, null, 'child_added');
  listen(reactionsRef, onReaction, null, 'child_changed');
}

// Attach to the full vote list only while votes are revealed. Outside that
// window the rules deny the read, so holding the listener open would just
// produce permission errors.
//
// A denial here is not necessarily final, which is why it now retries. We attach
// in response to `revealed` turning true on the meta listener — and that listener
// also fires on our own optimistic local write, before the server has committed
// it. Two things make the server still answer "revealed: false" at that moment:
// the reveal being queued behind a reconnect (Firebase restores listens before it
// flushes pending writes), or the round-trip simply not having landed yet.
// Treating either as "there are no votes" is what left a revealed room showing
// every vote as "—", with no way out but a new round.
function syncVotesListener(code, revealed) {
  votesWanted = revealed;

  if (!revealed) {
    cancelVotesRetry();
    detachVotesListener();
    roomVotes = {};
    return;
  }
  if (votesRef) return;

  votesRef = rRef(`rooms/${code}/votes`);
  votesCb = votesRef.on('value',
    snap => {
      cancelVotesRetry();
      roomVotes = snap.val() || {};
      renderIfReady();
    },
    () => {
      // Whatever we already read stays on screen. Anything stale is cleared by the
      // !revealed branch above when the round ends, so the only thing holding on to
      // it avoids is a flash of "—" between the denial and the retry.
      detachVotesListener();
      scheduleVotesRetry(code);
    }
  );
}

// Backoff rather than a tight loop: each attempt costs a round-trip, and if the
// read really is denied for good we stop asking instead of hammering the rules.
function scheduleVotesRetry(code) {
  if (votesRetryTimer || !votesWanted || votesRetries >= VOTES_RETRY_MAX) return;
  const delay = VOTES_RETRY_BASE_MS * Math.pow(2, votesRetries);
  votesRetries += 1;
  votesRetryTimer = setTimeout(() => {
    votesRetryTimer = null;
    if (votesWanted && currentRoomCode === code) syncVotesListener(code, true);
  }, delay);
}

function handleRoomClosed() {
  if (leavingIntentionally) return;
  handleRemoved('closed');
}

// Losing the room is not something the user did wrong, so it doesn't get an
// alert box: tear down, then hand them the join page with the reason on it.
function handleRemoved(reason) {
  const code = currentRoomCode;
  stopPresence();
  detachRoomListeners();
  clearSession();
  location.replace(`${JOIN_PAGE}?roomId=${encodeURIComponent(code || '')}&reason=${reason}`);
}

// Presence
//
// `connected` cannot be written once and left alone, which is what it was before:
// a background tab gets its timers throttled, Firebase's keepalive misses, the
// socket drops, and the onDisconnect hook writes `connected: false`. The client
// then reconnects on its own — but nothing put the flag back, so the badge said
// "offline" for the rest of the meeting even though the room was working.
//
// Worse, the hook is one-shot: Firebase clears its onDisconnect tree when it
// fires, so after that first drop nobody was marking us offline either. The flag
// was stuck at whatever the last disconnect left behind.
//
// So presence has to be driven by the connection itself. `.info/connected` is a
// client-local value the SDK maintains, readable without a rule, and it fires on
// every transition — including each reconnect, which is exactly the moment the
// flag and the hook both need re-establishing.

let presenceInfoRef = null;
let presenceInfoCb = null;
let presencePRef = null;
let presenceRRef = null;      // our reaction slot, cleaned up by the same hook

function startPresence(code, participantId) {
  stopPresence();
  presencePRef = rRef(`rooms/${code}/participants/${participantId}`);
  presenceRRef = rRef(`rooms/${code}/reactions/${participantId}`);
  presenceInfoRef = rRef('.info/connected');

  presenceInfoCb = presenceInfoRef.on('value', snap => {
    // Going down needs nothing from us: the onDisconnect hook below is what
    // writes `connected: false`, and it is the server that runs it, so it still
    // works for the case this whole flag exists for — a tab that just closes.
    if (snap.val() !== true) return;

    const pRef = presencePRef;

    // Arm the hook before claiming to be online. The other order leaves a window
    // where a drop would strand us marked connected, which is the failure that is
    // actually visible to everyone else in the room.
    pRef.onDisconnect().update({ connected: false })
      .then(() => {
        if (presencePRef !== pRef) return;   // left the room while this was in flight
        return pRef.update({ connected: true });
      })
      .catch(() => {});

    // Our last reaction goes with us. It is a two-second thing on screen, but the
    // node it was written to stays until something removes it, and a slot left by
    // a closed tab would otherwise sit there until the room expired. Armed here
    // for the same reason as the hook above: Firebase clears the whole
    // onDisconnect tree once it fires, so every reconnect has to re-establish it.
    if (presenceRRef) presenceRRef.onDisconnect().remove().catch(() => {});

    onReconnected();
  });
}

function stopPresence() {
  if (presenceInfoRef) presenceInfoRef.off('value', presenceInfoCb);
  presenceInfoRef = null;
  presenceInfoCb = null;
  presencePRef = null;
  presenceRRef = null;
}

// A reconnect can also have stranded the vote list: if the reveal was still
// pending when the socket came back, the re-sent listen raced ahead of it and was
// denied. Re-drive it against what we believe the room state to be.
function onReconnected() {
  if (roomMeta && currentRoomCode) {
    cancelVotesRetry();
    syncVotesListener(currentRoomCode, !!roomMeta.revealed);
  }
}

// Entering the room
//
// Both the "I just created or joined it" case and the "I refreshed the page"
// case come through here. It only works while we still hold the auth uid that
// owns the participant node — otherwise the rules would reject our writes, so we
// send the user back to the join form instead of half-joining.
//
// Returns null on success, or the reason the session could not be used.
async function restoreSession(session) {
  try {
    await ensureAuth();
  } catch {
    return 'session';
  }

  const meta = (await rRef(`rooms/${session.roomCode}/meta`).once('value')).val();
  if (!meta) {
    clearSession();
    return 'closed';
  }
  if (isStale(meta)) {
    sweepStaleRoom(session.roomCode);
    clearSession();
    return 'expired';
  }

  const pRef = rRef(`rooms/${session.roomCode}/participants/${session.participantId}`);
  const me = (await pRef.once('value')).val();
  if (!me || me.ownerUid !== currentUid) {
    clearSession();
    return 'session';
  }

  currentParticipantId = session.participantId;
  currentRoomCode = session.roomCode;

  subscribeToRoom(session.roomCode);

  // Presence starts here rather than at create/join time, because navigating from
  // those pages to this one would have fired the disconnect hook straight away.
  // After subscribeToRoom, so its reconnect handling has room state to work with.
  startPresence(session.roomCode, session.participantId);
  return null;
}

// Room actions

async function vote(value) {
  if (!currentRoomCode || !currentParticipantId) return;
  if (roomMeta && roomMeta.revealed) return;

  const next = (myVote === value) ? null : value;

  // The vote goes to a node nobody else can read yet; only the fact that we
  // voted is public, which is all the participant list needs to show.
  await rRef(`rooms/${currentRoomCode}/votes/${currentParticipantId}`).set(next);
  await rRef(`rooms/${currentRoomCode}/participants/${currentParticipantId}`)
    .update({ hasVoted: next !== null });
  touchRoom();
}

function revealVotes() {
  rRef(`rooms/${currentRoomCode}/meta`)
    .update({ revealed: true, lastActiveAt: serverTime() });
}

function newRound() {
  const updates = {
    'meta/revealed': false,
    'meta/lastActiveAt': serverTime(),
    votes: null,
    // Reactions have already expired on screen by the time anyone starts a new
    // round; this just stops the slots lingering in the data for a whole meeting.
    reactions: null,
  };
  roomParticipants.forEach(p => { updates[`participants/${p.id}/hasVoted`] = false; });
  rRef(`rooms/${currentRoomCode}`).update(updates);
}

function kickParticipant(targetId) {
  if (targetId === currentParticipantId) return;
  rRef(`rooms/${currentRoomCode}`).update({
    [`participants/${targetId}`]: null,
    [`votes/${targetId}`]: null,
    [`reactions/${targetId}`]: null,
    'meta/lastActiveAt': serverTime(),
  });
}

async function leaveRoom() {
  if (!currentRoomCode || !currentParticipantId) return;

  leavingIntentionally = true;

  // Stop presence before cancelling, or the `.info/connected` handler could arm a
  // fresh hook straight after — and re-create the participant node we are about to
  // delete.
  stopPresence();

  // Cancel the Firebase onDisconnect hooks so they don't fire after we remove
  // ourselves. Two of them now, at two paths — cancelling one says nothing about
  // the other.
  const myReactionRef = rRef(`rooms/${currentRoomCode}/reactions/${currentParticipantId}`);
  await myReactionRef.onDisconnect().cancel().catch(() => {});
  await rRef(`rooms/${currentRoomCode}/participants/${currentParticipantId}`)
    .onDisconnect().cancel();

  if (amFacilitator()) {
    // Facilitator leaving — delete the whole room, which kicks everyone
    await rRef(`rooms/${currentRoomCode}`).remove();
  } else {
    // Regular participant — remove self, and our vote and last reaction with us
    await rRef(`rooms/${currentRoomCode}/votes/${currentParticipantId}`).remove().catch(() => {});
    await myReactionRef.remove().catch(() => {});
    await rRef(`rooms/${currentRoomCode}/participants/${currentParticipantId}`).remove();
  }

  // Tear down listeners and hand the browser back to the home page — leaving a
  // room is a way out of the app, not a trip back to a form.
  detachRoomListeners();
  clearSession();
  location.replace(HOME_PAGE);
}

// Who hosts the room comes from the room's facilitatorUid, never from a flag on
// the participant node — a flag there would be writable by the person it grants.
function amFacilitator() {
  return !!(roomMeta && currentUid && roomMeta.facilitatorUid === currentUid);
}

// Sharing
//
// The invite link points at the join page with the code in it, so a recipient
// lands on a form that asks for nothing but their name — no tab to pick, no code
// to retype. Nothing secret travels in it: the room code is not a credential,
// and the rules still hand out an auth uid of their own to whoever follows it.

let shareResetTimer = null;

function buildInviteLink(code) {
  const url = new URL(JOIN_PAGE, window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('roomId', code);
  return url.toString();
}

// The async Clipboard API is unavailable on file:// and plain http, which is
// how this page often gets opened, so fall back to the old selection trick
// rather than silently failing there.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function shareRoom() {
  if (!currentRoomCode) return;

  const btn = document.getElementById('btn-share');
  const label = document.getElementById('btn-share-label');
  const status = document.getElementById('share-status');
  const link = buildInviteLink(currentRoomCode);

  const copied = await copyText(link);
  clearTimeout(shareResetTimer);

  if (copied) {
    btn.classList.add('copied');
    label.textContent = 'Copied!';
    status.textContent = 'Invite link copied to the clipboard.';
  } else {
    // Don't claim a copy that did not happen — hand the link over so it can be
    // copied by hand instead.
    label.textContent = 'Copy failed';
    status.textContent = 'Could not copy automatically.';
    prompt('Copy this invite link:', link);
  }

  shareResetTimer = setTimeout(() => {
    btn.classList.remove('copied');
    label.textContent = 'Share';
    status.textContent = '';
  }, 2000);
}

// Reactions
//
// A side channel for the things a card cannot say: that you agree, that you
// don't, that someone should wake up. Secondary by construction — the bar is
// hidden until you ask for it, and nothing here touches the estimating flow.
//
// Sending is two steps: arm a reaction, then click a person. That is one step
// more than every other product trains people to expect, so the awkward moment is
// the silence right after the first click — something tinted, nothing sent, and no
// sign an action is still owed. setArmed() below is where that gets addressed, and
// most of what it does is say out loud what state we are in.
//
// The shape of the data is the other half of the design: the write *is* the event,
// and nothing is ever written to end one. Each client animates an arrival for a
// couple of seconds and forgets it, so a reaction costs exactly one small write
// and no cleanup round-trip.

// The reaction set — the one place to edit. Add, remove or reorder entries
// freely: the rules validate `kind` by shape rather than by listing the values,
// so nothing here needs a rules change or a console publish. A client that has
// never heard of a kind looks it up, misses, and renders nothing, which is also
// what makes an old open tab harmless.
//
// `icon` is a Lucide path — the same family as every other icon in the product,
// because that is chrome. `emoji` is what actually lands on someone's row, which
// is content, and is the one place emoji belong.
const REACTIONS = [
  { kind: 'agree', emoji: '👍', label: 'Agree',
    icon: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>' },
  { kind: 'great', emoji: '⚡', label: 'Great!',
    icon: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>' },
  { kind: 'bad', emoji: '⛔', label: 'Bad idea',
    icon: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>' },
  { kind: 'angry', emoji: '😡', label: 'Angry',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><path d="M7.5 8 10 9"/><path d="m14 9 2.5-1"/><path d="M9 10h.01"/><path d="M15 10h.01"/>' },
  { kind: 'love', emoji: '💙', label: 'Love it',
    icon: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' },
];

const REACTION_BY_KIND = new Map(REACTIONS.map(r => [r.kind, r]));

// The caption carries the instruction at rest, not just while armed: the two-step
// is explained before anyone has the chance to be confused by it.
const HINT_REST = 'Pick one, then click a name';
const HINT_AIMING = 'Now click a name';

let reactionsOn = false;              // is the composer showing
let armedKind = null;                 // picked up, waiting for a target
let lastReactionSentAt = 0;
let hintResetTimer = null;

const activeReactions = new Map();    // targetPid -> { kind, at } — at most one per row
const reactionTimers = new Map();     // targetPid -> timeout that expires it

function announceReaction(text) {
  const status = document.getElementById('reaction-status');
  if (status) status.textContent = text;
}

function setHint(text) {
  clearTimeout(hintResetTimer);
  const hint = document.getElementById('reaction-hint');
  if (hint) hint.textContent = text;
}

// Say something for a beat, then fall back to whatever the current state says —
// the same shape as the "Copied!" label on the share button.
function flashHint(text) {
  setHint(text);
  hintResetTimer = setTimeout(() => {
    const hint = document.getElementById('reaction-hint');
    if (hint) hint.textContent = armedKind ? HINT_AIMING : HINT_REST;
  }, 1200);
}

// Receiving
//
// Anything that arrives is either fresh enough to animate or already over. That
// single test is also what stops a page load replaying history: child_added fires
// for every slot already in the room when we attach, and those are all older than
// the window.
function receiveReaction(r) {
  if (!r || typeof r.to !== 'string' || typeof r.at !== 'number') return;
  if (!REACTION_BY_KIND.has(r.kind)) return;                  // not a kind we know
  if (!roomParticipants.some(p => p.id === r.to)) return;     // target has left

  // Clamped rather than rejected below zero: our estimate of the server clock can
  // sit a hair behind it, and dropping a reaction for arriving "too early" would
  // be the same bug as dropping it for being too old.
  const age = Math.max(0, serverNow() - r.at);
  if (age >= REACTION_TTL_MS) return;

  activeReactions.set(r.to, { kind: r.kind, at: r.at });

  clearTimeout(reactionTimers.get(r.to));
  reactionTimers.set(r.to, setTimeout(() => {
    reactionTimers.delete(r.to);
    activeReactions.delete(r.to);
    paintReactions();
  }, REACTION_TTL_MS - age));

  paintReactions();
}

function clearReactions() {
  reactionTimers.forEach(id => clearTimeout(id));
  reactionTimers.clear();
  activeReactions.clear();
}

// Put the live reactions back on the rows. Called after every render as well as on
// arrival, because renderRoom rebuilds the whole list and takes them with it.
//
// The chip goes next to the name rather than into the badge cluster on the right.
// That cluster is a column: every row's "Voted / Waiting…" badge lines up with the
// one above it, and inserting anything there pushes the whole column sideways for
// two seconds, so a single reaction visibly breaks the alignment of the list. The
// name side has slack, and "reaction next to the person" reads correctly anyway.
function paintReactions() {
  const ul = document.getElementById('participant-list');
  if (!ul) return;

  ul.querySelectorAll('.reaction-pop:not(.preview)').forEach(el => el.remove());
  if (!activeReactions.size) return;

  ul.querySelectorAll('.participant-item').forEach(li => {
    const entry = activeReactions.get(li.dataset.id);
    const reaction = entry && REACTION_BY_KIND.get(entry.kind);
    const slot = li.querySelector('.participant-name');
    if (!reaction || !slot) return;

    const chip = document.createElement('span');
    chip.className = 'reaction-pop';
    chip.textContent = reaction.emoji;
    // Resume, don't restart. A vote by anyone rebuilds this list, and a reaction
    // that outlives one would otherwise begin its animation again from the top —
    // then get cut off early by the timer, which is counting from the original
    // arrival. A negative delay seeks into the animation instead.
    chip.style.animationDelay = `-${Math.max(0, serverNow() - entry.at)}ms`;
    slot.appendChild(chip);
  });
}

// The ghost copy shown while hovering or focusing a row with something armed:
// the glyph that will land, where it will land, at a whisper. This is the cue
// that explains the whole interaction without words.
function showReactionPreview(li) {
  const reaction = armedKind && REACTION_BY_KIND.get(armedKind);
  const slot = li.querySelector('.participant-name');
  if (!reaction || !slot || slot.querySelector('.reaction-pop.preview')) return;

  const chip = document.createElement('span');
  chip.className = 'reaction-pop preview';
  chip.textContent = reaction.emoji;
  slot.appendChild(chip);
}

function clearReactionPreviews() {
  document.querySelectorAll('.reaction-pop.preview').forEach(el => el.remove());
}

// Arming
//
// One function owns every signal that a choice is outstanding: the caption, the
// picked-up button, the four that recede, and the participant list turning into a
// target area. They are all the same fact stated four ways, so they are set in one
// place and cannot drift apart.
function setArmed(kind) {
  armedKind = kind || null;
  clearReactionPreviews();

  document.querySelectorAll('.reaction-btn').forEach(btn => {
    const on = btn.dataset.kind === armedKind;
    btn.classList.toggle('armed', on);
    btn.setAttribute('aria-pressed', String(on));
  });

  const bar = document.getElementById('reaction-bar');
  const ul = document.getElementById('participant-list');
  if (bar) bar.classList.toggle('armed', !!armedKind);
  if (ul) ul.classList.toggle('aiming', !!armedKind);

  if (armedKind) {
    setHint(HINT_AIMING);
    // The visual cues do not exist for a screen reader, so this is the whole
    // interaction in one sentence, including the way out of it.
    announceReaction(`${REACTION_BY_KIND.get(armedKind).label} ready. `
      + 'Click a name to send it, or press Escape to cancel.');
  } else {
    setHint(HINT_REST);
  }

  // Rows gain and lose their target semantics with the armed state.
  renderIfReady();
}

// Cancelling is not silent. Clicking an armed button again is the opposite of what
// someone expecting "click sends" would predict, so it has to leave a mark —
// otherwise the reasonable conclusion is that the feature is broken.
function disarm(message) {
  if (!armedKind) return;
  setArmed(null);
  if (message) {
    flashHint(message);
    announceReaction(message);
  }
}

// Sending

function throwReaction(targetPid) {
  if (!armedKind || !currentRoomCode || !currentParticipantId) return;

  // Refused here rather than by the rules. They enforce a 1200ms gap, and a write
  // that trips it comes back as a permission error — which reads as a bug, not a
  // speed limit. So the client keeps its own slightly wider gap and says why.
  if (Date.now() - lastReactionSentAt < REACTION_COOLDOWN_MS) {
    flashHint('One at a time…');
    announceReaction('Too fast — wait a moment before sending another reaction.');
    return;
  }

  const kind = armedKind;
  const target = roomParticipants.find(p => p.id === targetPid);
  if (!target) return;

  lastReactionSentAt = Date.now();
  clearReactionPreviews();

  // No touchRoom() here, deliberately. Reactions are not evidence that anyone is
  // estimating, and letting them refresh lastActiveAt would let a room that has
  // turned into a chat keep itself alive past the 24h TTL.
  rRef(`rooms/${currentRoomCode}/reactions/${currentParticipantId}`)
    .set({ kind, to: targetPid, at: serverTime() })
    .catch(() => {
      lastReactionSentAt = 0;      // it never landed; don't hold the cooldown against them
      flashHint('Could not send');
    });

  // One throw per arm. The mode ends with the send, so nothing is left loaded.
  setArmed(null);
  announceReaction(`${REACTION_BY_KIND.get(kind).label} sent to ${target.name}.`);
}

// The composer
//
// Built once from REACTIONS into a container the render cycle never touches, so
// adding a reaction means editing that array and nothing else.
function renderReactionBar() {
  const bar = document.getElementById('reaction-bar');
  if (!bar) return;

  REACTIONS.forEach(r => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon reaction-btn';
    btn.dataset.kind = r.kind;
    btn.title = r.label;
    btn.setAttribute('aria-label', r.label);
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<svg class="icon" ${ICON_ATTRS}>${r.icon}</svg>`;
    btn.addEventListener('click', () => {
      if (armedKind === r.kind) disarm('Cancelled');
      else setArmed(r.kind);
    });
    bar.appendChild(btn);
  });

  setHint(HINT_REST);
}

// The toggle hides the composer, not reception. Gating both would mean that with
// the default off nobody ever sees a reaction, and the feature would look broken
// instead of merely quiet — this way the first person to try it makes it visible
// for everyone.
function setReactionsOn(on) {
  reactionsOn = !!on;

  const bar = document.getElementById('reaction-bar');
  const btn = document.getElementById('btn-reactions');
  if (bar) bar.classList.toggle('hidden', !reactionsOn);
  if (btn) {
    btn.setAttribute('aria-pressed', String(reactionsOn));
    btn.title = reactionsOn ? 'Hide reactions' : 'Show reactions';
  }

  saveReactionsPref(reactionsOn);
  if (!reactionsOn) setArmed(null);
}

// Consensus

function computeConsensus(votes) {
  const numeric = votes
    .filter(v => v !== null && v !== '?' && v !== '☕')
    .map(Number).filter(n => !isNaN(n));
  if (numeric.length === 0) return { avg: null, level: 'no-votes' };
  const avg = Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10;
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  return {
    avg, min, max,
    level: min === max ? 'unanimous' : max - min <= 2 ? 'close' : 'split',
  };
}

// Rendering

// Lucide paths, inlined as SVG markup. One icon family for the whole product,
// no CDN: there is no build step here, the room has to survive going offline,
// and every other third-party file we load is SRI-pinned.
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const ICONS = {
  x:     `<svg class="icon icon-xs" ${ICON_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  check: `<svg class="icon icon-xs" ${ICON_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`,
  minus: `<svg class="icon icon-xs" ${ICON_ATTRS}><path d="M5 12h14"/></svg>`,
};

// Fold the separate listener feeds back into the single room shape the renderer
// expects. Before reveal the only vote we can fill in is our own.
function renderIfReady() {
  if (!roomMeta || !participantsLoaded) return;

  const revealed = !!roomMeta.revealed;
  const room = {
    code: roomMeta.code,
    revealed,
    participants: roomParticipants.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      hasVoted: !!p.hasVoted,
      isFacilitator: p.ownerUid === roomMeta.facilitatorUid,
      vote: revealed
        ? (roomVotes[p.id] ?? null)
        : (p.id === currentParticipantId ? myVote : null),
    })),
  };

  if (document.getElementById('room-panel').classList.contains('hidden')) {
    showRoomPanel();
  }
  renderRoom(room);
}

function renderRoom(room) {
  const me = room.participants.find(p => p.id === currentParticipantId);
  const isFacilitator = amFacilitator();

  document.getElementById('room-code-display').textContent = room.code;

  // Participant list
  const ul = document.getElementById('participant-list');

  // The list is rebuilt from scratch below, which drops focus. That was invisible
  // while the only focusable thing in a row was the kick button; it is not, now
  // that the rows themselves are targets while a reaction is armed.
  const focusedRow = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.participant-item')
    : null;
  const focusedId = focusedRow ? focusedRow.dataset.id : null;

  ul.innerHTML = '';
  room.participants.forEach(p => {
    const li = document.createElement('li');
    li.className = 'participant-item' + (p.connected === false ? ' disconnected' : '');
    li.dataset.id = p.id;

    // Only a target while something is armed, so the list keeps its plain
    // semantics the rest of the time rather than announcing every teammate as a
    // button for no reason.
    //
    // Focusable and labelled, but deliberately not role="button": a button's
    // descendants are presentational, which would hide the facilitator's own
    // kick button inside this row from assistive tech for as long as a reaction
    // was armed. Losing that is worse than the row announcing itself as a
    // labelled focus stop.
    if (armedKind) {
      li.tabIndex = 0;
      li.setAttribute('aria-label',
        `${p.name} — send ${REACTION_BY_KIND.get(armedKind).label}`);
    }

    let voteHtml;
    if (room.revealed) {
      voteHtml = `<span class="vote-badge revealed">${escHtml(p.vote ?? '—')}</span>`;
    } else {
      voteHtml = p.hasVoted
        ? `<span class="vote-badge voted">Voted</span>`
        : `<span class="vote-badge waiting">Waiting...</span>`;
    }

    const youTag = p.id === currentParticipantId ? `<span class="you-tag">you</span>` : '';
    const roleTag = p.isFacilitator ? `<span class="role-tag">host</span>` : '';
    const offlineTag = p.connected === false ? `<span class="offline-tag">offline</span>` : '';
    const kickBtn = (isFacilitator && p.id !== currentParticipantId)
      ? `<button class="btn-icon danger kick-btn" data-id="${escHtml(p.id)}" title="Remove participant" aria-label="Remove ${escHtml(p.name)}">${ICONS.x}</button>`
      : '';

    li.innerHTML = `
      <span class="participant-name">${escHtml(p.name)}${youTag}${roleTag}${offlineTag}</span>
      <span class="participant-right">${voteHtml}${kickBtn}</span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.kick-btn').forEach(btn =>
    btn.addEventListener('click', () => kickParticipant(btn.dataset.id))
  );

  if (focusedId) {
    ul.querySelectorAll('.participant-item').forEach(li => {
      if (li.dataset.id === focusedId && li.tabIndex >= 0) li.focus();
    });
  }

  // The rebuild also dropped the aim preview. Focus restores itself — .focus()
  // above re-fires focusin — but a stationary pointer produces no new event, so
  // ask the DOM what it is over instead of waiting to be told.
  if (armedKind) {
    const over = ul.querySelector('.participant-item:hover');
    if (over) showReactionPreview(over);
  }

  // Live reactions went out with the old rows; put them back mid-flight.
  paintReactions();

  // Card deck
  renderCards(room, me);

  // Facilitator controls
  const controls = document.getElementById('facilitator-controls');
  controls.classList.toggle('hidden', !isFacilitator);
  if (isFacilitator) {
    const anyVoted = room.participants.some(p => p.hasVoted);
    document.getElementById('btn-reveal').disabled = room.revealed || !anyVoted;
    document.getElementById('btn-reset').disabled = !room.revealed && !anyVoted;
  }

  // Results
  const resultsPanel = document.getElementById('results-panel');
  resultsPanel.classList.toggle('hidden', !room.revealed);
  if (room.revealed) renderResults(room);
}

function renderCards(room, me) {
  const deck = document.getElementById('card-deck');
  deck.innerHTML = '';
  const disabled = room.revealed;
  CARDS.forEach(value => {
    const btn = document.createElement('button');
    btn.className = 'card' + (me && me.vote === value && !room.revealed ? ' selected' : '');
    btn.textContent = value;
    btn.disabled = disabled;
    btn.setAttribute('aria-label', 'Vote ' + value);
    btn.addEventListener('click', () => vote(value));
    deck.appendChild(btn);
  });
}

// The outcome leads, the breakdown follows. A two-column table needed its own
// header row on top of the panel title, which stacked two uppercase labels for
// what is usually a handful of names — so the per-person votes are chips now.
function renderResults(room) {
  const summary = document.getElementById('results-summary');
  const list = document.getElementById('results-votes');

  const consensus = computeConsensus(room.participants.map(p => p.vote));
  if (consensus.level === 'no-votes') {
    summary.innerHTML = `<span class="consensus-tag no-votes">No numeric votes cast</span>`;
  } else {
    // Icon plus word, so the state never rests on colour alone (§7).
    const labels = {
      unanimous: `${ICONS.check}Unanimous`,
      close:     `${ICONS.minus}Close`,
      split:     `${ICONS.x}Split`,
    };
    // The range only says something once the votes disagree.
    const spread = consensus.min === consensus.max
      ? ''
      : `<span class="results-spread">range ${consensus.min}–${consensus.max}</span>`;
    summary.innerHTML = `
      <span class="results-average">${consensus.avg}</span>
      <span class="results-average-label">average</span>
      <span class="consensus-tag ${consensus.level}">${labels[consensus.level]}</span>
      ${spread}
    `;
  }

  list.innerHTML = room.participants.map(p => `
    <li class="vote-chip">
      <span class="vote-chip-name">${escHtml(p.name)}</span>
      <span class="vote-chip-value">${escHtml(p.vote ?? '—')}</span>
    </li>`).join('');
}

// ―― Panel transitions ――

function showRoomPanel() {
  document.getElementById('room-loading').classList.add('hidden');
  document.getElementById('room-panel').classList.remove('hidden');
  document.getElementById('topbar-room').classList.remove('hidden');
}

// ―― Init ――

function initRoom() {
  initFirebase();

  document.getElementById('btn-reveal').addEventListener('click', revealVotes);
  document.getElementById('btn-reset').addEventListener('click', newRound);
  document.getElementById('btn-share').addEventListener('click', shareRoom);
  document.getElementById('btn-leave').addEventListener('click', () => leaveRoom());

  // Reactions. The bar is built once and the participant-list handlers are
  // delegated, so none of this is re-attached on every render.
  renderReactionBar();
  setReactionsOn(getReactionsPref());
  document.getElementById('btn-reactions')
    .addEventListener('click', () => setReactionsOn(!reactionsOn));

  const participantList = document.getElementById('participant-list');

  participantList.addEventListener('click', e => {
    if (!armedKind) return;
    if (e.target.closest('.kick-btn')) return;   // removing someone still wins
    const li = e.target.closest('.participant-item');
    if (li) throwReaction(li.dataset.id);
  });

  participantList.addEventListener('keydown', e => {
    if (!armedKind || (e.key !== 'Enter' && e.key !== ' ')) return;
    const li = e.target.closest('.participant-item');
    if (!li) return;
    e.preventDefault();                          // Space would scroll the page
    throwReaction(li.dataset.id);
  });

  // Preview on hover and on focus both, so the cue is not mouse-only.
  participantList.addEventListener('mouseover', e => {
    if (!armedKind) return;
    const li = e.target.closest('.participant-item');
    if (li) showReactionPreview(li);
  });
  participantList.addEventListener('mouseout', e => {
    if (e.target.closest('.participant-item')) clearReactionPreviews();
  });
  participantList.addEventListener('focusin', e => {
    if (!armedKind) return;
    const li = e.target.closest('.participant-item');
    if (li) { clearReactionPreviews(); showReactionPreview(li); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && armedKind) disarm('Cancelled');
  });

  // Old-style invite links (?join=true&roomId=CODE) used to land here. Keep them
  // working by forwarding to the page that now owns joining — and do the same for
  // a link to a room other than the one this tab is already in, since the link is
  // the more recent intent.
  const params = new URLSearchParams(window.location.search);
  const linkCode = (params.get('roomId') || '').toUpperCase().slice(0, 6);

  const session = getSession();
  if (!session?.roomCode || !session?.participantId || (linkCode && linkCode !== session.roomCode)) {
    location.replace(linkCode ? `${JOIN_PAGE}?roomId=${encodeURIComponent(linkCode)}` : JOIN_PAGE);
    return;
  }

  restoreSession(session).then(reason => {
    if (reason) {
      location.replace(`${JOIN_PAGE}?roomId=${encodeURIComponent(session.roomCode)}&reason=${reason}`);
    }
  });
}

document.addEventListener('DOMContentLoaded', initRoom);
