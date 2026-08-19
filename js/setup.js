// setup.js — the two entry pages: create a room, or join one.
//
// Creating and joining are separate pages on purpose. A single screen with two
// tabs meant someone arriving from an invite link landed on a form that also
// offered to create a room, which is never what they wanted. Each page here does
// one thing, and both hand off to room.html the same way: write the session,
// then navigate.
//
// The Firebase write happens here rather than on the room page so that failures
// ("Room not found") land next to the input that caused them.

const ROOM_PAGE = 'room.html';

// Notices we may be sent back here with, when the room page cannot keep someone
// in a room. Phrased as "what happened", not as an error code.
const RETURN_NOTICES = {
  expired: 'That room has expired. Rooms are deleted 24 hours after their last activity — ask for a new code.',
  closed:  'That room has been closed by its facilitator.',
  removed: 'You were removed from the room by the facilitator.',
  session: 'Your place in that room could not be restored. Enter your name to join it again.',
};

// ―― Form errors ――

function showFormError(formId, msg) {
  const form = document.getElementById(formId);
  if (!form) return;
  let err = form.querySelector('.form-error');
  if (!err) {
    err = document.createElement('p');
    err.className = 'form-error';
    form.insertBefore(err, form.querySelector('button[type="submit"]'));
  }
  err.textContent = msg;
}
function clearFormError(formId) {
  document.getElementById(formId)?.querySelector('.form-error')?.remove();
}

// ―― Room actions ――

async function createRoom(name) {
  try {
    await ensureAuth();
  } catch (err) {
    showFormError('form-create', authErrorMessage(err));
    return;
  }

  let code;
  for (let i = 0; i < 10; i++) {
    code = generateRoomCode();
    const snap = await rRef(`rooms/${code}/meta/code`).once('value');
    if (!snap.exists()) break;
  }

  const participantId = generateId();
  currentParticipantId = participantId;
  currentRoomCode = code;
  saveSession(participantId, code);

  try {
    await rRef(`rooms/${code}`).set({
      meta: {
        code,
        revealed: false,
        facilitatorUid: currentUid, // frozen by the rules — this is what makes someone the host
        createdAt: serverTime(),
        lastActiveAt: serverTime(),
      },
      participants: {
        [participantId]: {
          id: participantId, name, ownerUid: currentUid,
          hasVoted: false, connected: true, joinedAt: serverTime(),
        },
      },
    });
  } catch {
    currentRoomCode = null;
    currentParticipantId = null;
    clearSession();
    showFormError('form-create', 'Could not create the room. Please try again.');
    return;
  }

  // No onDisconnect hook here: navigating away would fire it immediately. The
  // room page installs it once it has picked the session up.
  enterRoom();
}

async function joinRoom(code, name) {
  try {
    await ensureAuth();
  } catch (err) {
    showFormError('form-join', authErrorMessage(err));
    return;
  }

  const meta = (await rRef(`rooms/${code}/meta`).once('value')).val();
  if (!meta) {
    showFormError('form-join', 'Room not found. Check the code and try again.');
    return;
  }
  if (isStale(meta)) {
    // Abandoned: treat it as gone, and collect it on the way past.
    sweepStaleRoom(code);
    showFormError('form-join', 'That room has expired. Ask for a new room code.');
    return;
  }

  const participantId = generateId();
  currentParticipantId = participantId;
  currentRoomCode = code;
  saveSession(participantId, code);

  try {
    await rRef(`rooms/${code}/participants/${participantId}`).set({
      id: participantId, name, ownerUid: currentUid,
      hasVoted: false, connected: true, joinedAt: serverTime(),
    });
  } catch {
    currentRoomCode = null;
    currentParticipantId = null;
    clearSession();
    showFormError('form-join', 'Could not join the room. Please try again.');
    return;
  }

  touchRoom();
  enterRoom();
}

// Replace rather than push, so Back from the room lands on the home page instead
// of re-submitting a form for a room we are already in.
function enterRoom() {
  location.replace(ROOM_PAGE);
}

// ―― Page init ――

// Sign in straight away, so the round-trip is already done by the time anyone
// submits — the anonymous sign-in should never be a step the user waits on. If
// it fails, say so now rather than letting someone type a name first: every
// action in the app depends on it.
function initSetupPage(formId) {
  initFirebase();
  ensureAuth().catch(err => {
    showFormError(formId, authErrorMessage(err));
    console.error('[ScrumEstimate] anonymous sign-in failed:', err);
  });
}

function initCreatePage() {
  initSetupPage('form-create');

  // Every meeting starts here, so this is where the previous ones get cleaned
  // up: rooms past the TTL are deleted on the way past. Fire-and-forget — it is
  // housekeeping, nothing on the page waits for it, and ensureAuth() hands back
  // the sign-in already in flight rather than a second one.
  ensureAuth().then(sweepAbandonedRooms).catch(() => {});

  document.getElementById('form-create').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('input-facilitator-name').value.trim().slice(0, 40);
    if (!name) return;
    clearFormError('form-create');
    createRoom(name);
  });
}

function initJoinPage() {
  initSetupPage('form-join');

  const params = new URLSearchParams(window.location.search);
  const preCode = (params.get('roomId') || '').toUpperCase().slice(0, 6);
  const reason = params.get('reason');

  // Someone re-clicking their own invite link is already in that room in this
  // tab: send them back to it rather than joining a second time and leaving a
  // ghost participant behind. Not done when the room page just sent us here — it
  // clears the session before redirecting, so there is no loop either way.
  const session = getSession();
  if (!reason && preCode && session?.participantId && session.roomCode === preCode) {
    location.replace(ROOM_PAGE);
    return;
  }

  const codeInput = document.getElementById('input-room-code');
  const nameInput = document.getElementById('input-participant-name');
  const notice = document.getElementById('join-notice');

  // Arriving from an invite link: the code is not something this person should
  // have to read off a chat message and retype, so it comes prefilled and the
  // page says which room it is. Still editable — a stale link is easier to fix
  // in place than to go back for.
  if (preCode) codeInput.value = preCode;

  if (reason && RETURN_NOTICES[reason]) {
    notice.textContent = RETURN_NOTICES[reason];
    notice.className = 'setup-notice warning';
  } else if (preCode) {
    notice.textContent = `You've been invited to room ${preCode}.`;
    notice.className = 'setup-notice';
  }

  // The name is the only thing an invited guest still has to supply.
  nameInput.focus();

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  document.getElementById('form-join').addEventListener('submit', e => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 40);
    const code = codeInput.value.trim().toUpperCase();
    if (!name || !code) return;
    clearFormError('form-join');
    joinRoom(code, name);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('form-create')) initCreatePage();
  else if (document.getElementById('form-join')) initJoinPage();
});
