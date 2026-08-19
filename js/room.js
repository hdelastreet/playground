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

function listen(ref, cb, errCb) {
  const bound = ref.on('value', cb, errCb || (() => {}));
  roomListeners.push({ ref, cb: bound });
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
  roomListeners.forEach(({ ref, cb }) => ref.off('value', cb));
  roomListeners = [];
  votesWanted = false;
  cancelVotesRetry();
  detachVotesListener();
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

function startPresence(code, participantId) {
  stopPresence();
  presencePRef = rRef(`rooms/${code}/participants/${participantId}`);
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

    onReconnected();
  });
}

function stopPresence() {
  if (presenceInfoRef) presenceInfoRef.off('value', presenceInfoCb);
  presenceInfoRef = null;
  presenceInfoCb = null;
  presencePRef = null;
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
  };
  roomParticipants.forEach(p => { updates[`participants/${p.id}/hasVoted`] = false; });
  rRef(`rooms/${currentRoomCode}`).update(updates);
}

function kickParticipant(targetId) {
  if (targetId === currentParticipantId) return;
  rRef(`rooms/${currentRoomCode}`).update({
    [`participants/${targetId}`]: null,
    [`votes/${targetId}`]: null,
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

  // Cancel the Firebase onDisconnect hook so it doesn't fire after we remove ourselves
  await rRef(`rooms/${currentRoomCode}/participants/${currentParticipantId}`)
    .onDisconnect().cancel();

  if (amFacilitator()) {
    // Facilitator leaving — delete the whole room, which kicks everyone
    await rRef(`rooms/${currentRoomCode}`).remove();
  } else {
    // Regular participant — remove self, and our vote along with us
    await rRef(`rooms/${currentRoomCode}/votes/${currentParticipantId}`).remove().catch(() => {});
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
  ul.innerHTML = '';
  room.participants.forEach(p => {
    const li = document.createElement('li');
    li.className = 'participant-item' + (p.connected === false ? ' disconnected' : '');

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

function renderResults(room) {
  const table = document.getElementById('results-table');
  const indicator = document.getElementById('consensus-indicator');

  table.innerHTML = `
    <thead><tr><th>Participant</th><th>Vote</th></tr></thead>
    <tbody>${room.participants.map(p =>
      `<tr><td>${escHtml(p.name)}</td><td class="vote-cell">${escHtml(p.vote ?? '-')}</td></tr>`
    ).join('')}</tbody>
  `;

  const consensus = computeConsensus(room.participants.map(p => p.vote));
  if (consensus.level === 'no-votes') {
    indicator.innerHTML = `<span class="consensus-tag no-votes">No numeric votes cast</span>`;
  } else {
    // Icon plus word, so the state never rests on colour alone (§7).
    const labels = {
      unanimous: `${ICONS.check}Unanimous`,
      close:     `${ICONS.minus}Close`,
      split:     `${ICONS.x}Split`,
    };
    indicator.innerHTML = `
      Average: <strong>${consensus.avg}</strong>
      <span class="consensus-tag ${consensus.level}">${labels[consensus.level]}</span>
    `;
  }
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
