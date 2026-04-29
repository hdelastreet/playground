// room.js â€” Phase 3: Multi-User Sync via Firebase Realtime Database
// No server needed â€” Firebase handles real-time sync across all computers.
//
// â”€â”€ SETUP: replace the placeholder values below with your Firebase project config â”€â”€
// (See the setup guide at the bottom of steps-to-build.html)

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCQYfUpOgKUw1sCdbXHc7zCav3SgSRE7Tg",
  authDomain: "estimateroom-97b7b.firebaseapp.com",
  databaseURL: "https://estimateroom-97b7b-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "estimateroom-97b7b",
  storageBucket: "estimateroom-97b7b.firebasestorage.app",
  messagingSenderId: "443595862572",
  appId: "1:443595862572:web:fafe0311a75d30c2c5d789"
};

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '?', 'â˜•'];
const SESSION_KEY = 'scrumestimate_session';

let db = null;
let currentParticipantId = null;
let currentRoomCode = null;
let activeRoomRef = null; // Firebase ref being listened to

// â”€â”€ Firebase init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function initFirebase() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();

  // Drive the connection status dot from Firebase's own connection state
  db.ref('.info/connected').on('value', snap => {
    setConnectionStatus(snap.val() ? 'connected' : 'disconnected');
  });
}

// â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// â”€â”€ Session persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(participantId, roomCode) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ participantId, roomCode }));
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// â”€â”€ Firebase helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function rRef(path) { return db.ref(path); }
function rootUpdate(updates) { return db.ref('/').update(updates); }

// Convert Firebase's key-value objects to sorted arrays
function normalizeRoom(raw) {
  const participants = Object.values(raw.participants || {})
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const stories = Object.values(raw.stories || {})
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return {
    code: raw.code,
    activeStoryId: raw.activeStoryId || null,
    revealed: !!raw.revealed,
    participants,
    stories,
  };
}

// â”€â”€ Real-time subscription â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function subscribeToRoom(code) {
  // Detach any previous listener
  if (activeRoomRef) activeRoomRef.off('value');

  activeRoomRef = rRef(`rooms/${code}`);
  activeRoomRef.on('value', snap => {
    if (!snap.exists()) {
      clearSession();
      alert('This room no longer exists.');
      location.reload();
      return;
    }
    const room = normalizeRoom(snap.val());

    // Detect if we were kicked (our participant ID is no longer in the room)
    const stillInRoom = room.participants.some(p => p.id === currentParticipantId);
    if (!stillInRoom) {
      clearSession();
      activeRoomRef.off('value');
      alert('You were removed from the room by the facilitator.');
      location.reload();
      return;
    }

    if (document.getElementById('room-panel').classList.contains('hidden')) {
      showRoomPanel();
    }
    renderRoom(room);
  });
}

// â”€â”€ Room Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function createRoom(name) {
  setConnectionStatus('connecting');
  let code;
  for (let i = 0; i < 10; i++) {
    code = generateRoomCode();
    const snap = await rRef(`rooms/${code}`).once('value');
    if (!snap.exists()) break;
  }

  const participantId = generateId();
  currentParticipantId = participantId;
  currentRoomCode = code;
  saveSession(participantId, code);

  await rRef(`rooms/${code}`).set({
    code,
    activeStoryId: null,
    revealed: false,
    participants: {
      [participantId]: {
        id: participantId, name, isFacilitator: true,
        hasVoted: false, vote: null, connected: true, joinedAt: Date.now(),
      },
    },
    stories: {},
  });

  // Auto-mark offline on unexpected disconnect
  rRef(`rooms/${code}/participants/${participantId}`)
    .onDisconnect().update({ connected: false });

  subscribeToRoom(code);
}

async function joinRoom(code, name) {
  setConnectionStatus('connecting');
  const snap = await rRef(`rooms/${code}`).once('value');
  if (!snap.exists()) {
    showFormError('form-join', 'Room not found. Check the code and try again.');
    setConnectionStatus('disconnected');
    return;
  }

  const raw = snap.val();

  // Restore session (page refresh)
  const session = getSession();
  if (session && session.roomCode === code && raw.participants?.[session.participantId]) {
    currentParticipantId = session.participantId;
    currentRoomCode = code;
    await rRef(`rooms/${code}/participants/${currentParticipantId}`).update({ connected: true });
    rRef(`rooms/${code}/participants/${currentParticipantId}`)
      .onDisconnect().update({ connected: false });
    subscribeToRoom(code);
    return;
  }

  const participantId = generateId();
  currentParticipantId = participantId;
  currentRoomCode = code;
  saveSession(participantId, code);

  await rRef(`rooms/${code}/participants/${participantId}`).set({
    id: participantId, name, isFacilitator: false,
    hasVoted: false, vote: null, connected: true, joinedAt: Date.now(),
  });

  rRef(`rooms/${code}/participants/${participantId}`)
    .onDisconnect().update({ connected: false });

  subscribeToRoom(code);
}

async function vote(value) {
  const revealedSnap = await rRef(`rooms/${currentRoomCode}/revealed`).once('value');
  if (revealedSnap.val()) return;
  const pRef = rRef(`rooms/${currentRoomCode}/participants/${currentParticipantId}`);
  const voteSnap = await pRef.child('vote').once('value');
  if (voteSnap.val() === value) {
    await pRef.update({ vote: null, hasVoted: false });
  } else {
    await pRef.update({ vote: value, hasVoted: true });
  }
}

function revealVotes() {
  rRef(`rooms/${currentRoomCode}`).update({ revealed: true });
}

async function newRound() {
  const pSnap = await rRef(`rooms/${currentRoomCode}/participants`).once('value');
  const updates = { [`rooms/${currentRoomCode}/revealed`]: false };
  pSnap.forEach(child => {
    updates[`rooms/${currentRoomCode}/participants/${child.key}/vote`] = null;
    updates[`rooms/${currentRoomCode}/participants/${child.key}/hasVoted`] = false;
  });
  rootUpdate(updates);
}

async function addStory(title) {
  const storyId = generateId();
  const updates = {
    [`rooms/${currentRoomCode}/stories/${storyId}`]: {
      id: storyId, title, status: 'pending', points: null, createdAt: Date.now(),
    },
  };
  const activeSnap = await rRef(`rooms/${currentRoomCode}/activeStoryId`).once('value');
  if (!activeSnap.val()) {
    updates[`rooms/${currentRoomCode}/activeStoryId`] = storyId;
  }
  rootUpdate(updates);
}

async function removeStory(storyId) {
  const snap = await rRef(`rooms/${currentRoomCode}`).once('value');
  const raw = snap.val();
  const updates = { [`rooms/${currentRoomCode}/stories/${storyId}`]: null };

  if (raw.activeStoryId === storyId) {
    const remaining = Object.values(raw.stories || {})
      .filter(s => s.id !== storyId && s.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
    updates[`rooms/${currentRoomCode}/activeStoryId`] = remaining[0]?.id || null;
    updates[`rooms/${currentRoomCode}/revealed`] = false;
    Object.values(raw.participants || {}).forEach(p => {
      updates[`rooms/${currentRoomCode}/participants/${p.id}/vote`] = null;
      updates[`rooms/${currentRoomCode}/participants/${p.id}/hasVoted`] = false;
    });
  }
  rootUpdate(updates);
}

async function setActiveStory(storyId) {
  const pSnap = await rRef(`rooms/${currentRoomCode}/participants`).once('value');
  const updates = {
    [`rooms/${currentRoomCode}/activeStoryId`]: storyId,
    [`rooms/${currentRoomCode}/revealed`]: false,
  };
  pSnap.forEach(child => {
    updates[`rooms/${currentRoomCode}/participants/${child.key}/vote`] = null;
    updates[`rooms/${currentRoomCode}/participants/${child.key}/hasVoted`] = false;
  });
  rootUpdate(updates);
}

async function confirmStory(points) {
  const snap = await rRef(`rooms/${currentRoomCode}`).once('value');
  const raw = snap.val();
  const activeId = raw.activeStoryId;
  const stories = Object.values(raw.stories || {}).sort((a, b) => a.createdAt - b.createdAt);
  const next = stories.find(s => s.id !== activeId && s.status === 'pending');

  const updates = {
    [`rooms/${currentRoomCode}/stories/${activeId}/status`]: 'done',
    [`rooms/${currentRoomCode}/stories/${activeId}/points`]: points,
    [`rooms/${currentRoomCode}/activeStoryId`]: next?.id || null,
    [`rooms/${currentRoomCode}/revealed`]: false,
  };
  Object.values(raw.participants || {}).forEach(p => {
    updates[`rooms/${currentRoomCode}/participants/${p.id}/vote`] = null;
    updates[`rooms/${currentRoomCode}/participants/${p.id}/hasVoted`] = false;
  });
  rootUpdate(updates);
}

function kickParticipant(targetId) {
  if (targetId === currentParticipantId) return;
  rRef(`rooms/${currentRoomCode}/participants/${targetId}`).remove();
}

// â”€â”€ Consensus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function computeConsensus(votes) {
  const numeric = votes
    .filter(v => v !== null && v !== '?' && v !== 'â˜•')
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

// â”€â”€ Connection status â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function setConnectionStatus(status) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot) return;
  dot.className = 'conn-dot ' + status;
  label.textContent = { connecting: 'Connectingâ€¦', connected: 'Connected', disconnected: 'Reconnectingâ€¦' }[status] || '';
}

// â”€â”€ Rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function renderRoom(room) {
  const me = room.participants.find(p => p.id === currentParticipantId);
  const isFacilitator = !!(me && me.isFacilitator);
  const activeStory = room.stories.find(s => s.id === room.activeStoryId);

  document.getElementById('room-code-display').textContent = room.code;
  document.getElementById('active-story-title').textContent =
    activeStory ? activeStory.title : 'No active story â€” add one below';
  document.getElementById('facilitator-badge').classList.toggle('hidden', !isFacilitator);

  // Participant list
  const ul = document.getElementById('participant-list');
  ul.innerHTML = '';
  room.participants.forEach(p => {
    const li = document.createElement('li');
    li.className = 'participant-item' + (p.connected === false ? ' disconnected' : '');

    let voteHtml;
    if (room.revealed) {
      voteHtml = `<span class="vote-badge revealed">${escHtml(p.vote ?? 'â€”')}</span>`;
    } else {
      voteHtml = p.hasVoted
        ? `<span class="vote-badge voted">Voted</span>`
        : `<span class="vote-badge waiting">Waiting...</span>`;
    }

    const roleTag = p.isFacilitator ? `<span class="role-tag">host</span>` : '';
    const offlineTag = p.connected === false ? `<span class="offline-tag">offline</span>` : '';
    const kickBtn = (isFacilitator && p.id !== currentParticipantId)
      ? `<button class="btn-icon danger kick-btn" data-id="${escHtml(p.id)}" title="Remove participant">âœ•</button>`
      : '';

    li.innerHTML = `
      <span class="participant-name">${escHtml(p.name)}${roleTag}${offlineTag}</span>
      <span class="participant-right">${voteHtml}${kickBtn}</span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('.kick-btn').forEach(btn =>
    btn.addEventListener('click', () => kickParticipant(btn.dataset.id))
  );

  // Story queue (facilitator only)
  const storySection = document.getElementById('story-section');
  storySection.classList.toggle('hidden', !isFacilitator);
  if (isFacilitator) renderStoryQueue(room);

  // Card deck
  renderCards(room, me);

  // Facilitator controls
  const controls = document.getElementById('facilitator-controls');
  controls.classList.toggle('hidden', !isFacilitator);
  if (isFacilitator) {
    const anyVoted = room.participants.some(p => p.hasVoted);
    document.getElementById('btn-reveal').disabled = room.revealed || !anyVoted || !room.activeStoryId;
    document.getElementById('btn-reset').disabled = !room.revealed && !anyVoted;
  }

  // Results
  const resultsPanel = document.getElementById('results-panel');
  resultsPanel.classList.toggle('hidden', !room.revealed);
  if (room.revealed) renderResults(room, isFacilitator);
}

function renderCards(room, me) {
  const deck = document.getElementById('card-deck');
  deck.innerHTML = '';
  const disabled = room.revealed || !room.activeStoryId;
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

function renderStoryQueue(room) {
  const ul = document.getElementById('story-queue');
  ul.innerHTML = '';
  if (room.stories.length === 0) {
    ul.innerHTML = '<li class="story-empty">No stories yet.</li>';
    return;
  }
  room.stories.forEach(story => {
    const isActive = story.id === room.activeStoryId;
    const isDone = story.status === 'done';
    const li = document.createElement('li');
    li.className = 'story-item' + (isActive ? ' active' : '') + (isDone ? ' done' : '');
    const activateBtn = (!isDone && !isActive)
      ? `<button class="btn-icon" data-action="activate" data-id="${escHtml(story.id)}" title="Set active">â–¶</button>`
      : '';
    const pointsBadge = isDone && story.points !== null
      ? `<span class="story-points-badge">${story.points}pt</span>` : '';
    li.innerHTML = `
      <span class="story-title-text">${escHtml(story.title)}</span>
      ${pointsBadge}
      <span class="story-item-actions">
        ${activateBtn}
        <button class="btn-icon danger" data-action="remove" data-id="${escHtml(story.id)}" title="Remove">âœ•</button>
      </span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-action]').forEach(btn =>
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'activate') setActiveStory(btn.dataset.id);
      if (btn.dataset.action === 'remove') removeStory(btn.dataset.id);
    })
  );
}

function renderResults(room, isFacilitator) {
  const table = document.getElementById('results-table');
  const indicator = document.getElementById('consensus-indicator');
  const btnConfirm = document.getElementById('btn-confirm-story');

  table.innerHTML = `
    <thead><tr><th>Participant</th><th>Vote</th></tr></thead>
    <tbody>${room.participants.map(p =>
      `<tr><td>${escHtml(p.name)}</td><td class="vote-cell">${escHtml(p.vote ?? 'â€”')}</td></tr>`
    ).join('')}</tbody>
  `;

  const consensus = computeConsensus(room.participants.map(p => p.vote));
  if (consensus.level === 'no-votes') {
    indicator.innerHTML = `<span class="consensus-tag no-votes">No numeric votes cast</span>`;
  } else {
    const labels = { unanimous: 'âœ” Unanimous!', close: '~ Close', split: 'âš  Split' };
    indicator.innerHTML = `
      Average: <strong>${consensus.avg}</strong>
      &nbsp;<span class="consensus-tag ${consensus.level}">${labels[consensus.level]}</span>
    `;
  }

  if (isFacilitator && room.activeStoryId) {
    btnConfirm.classList.remove('hidden');
    btnConfirm.onclick = () => confirmStory(consensus.avg);
  } else {
    btnConfirm.classList.add('hidden');
  }
}

// â”€â”€ Form errors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function showFormError(formId, msg) {
  const form = document.getElementById(formId);
  let err = form.querySelector('.form-error');
  if (!err) {
    err = document.createElement('p');
    err.className = 'form-error';
    form.insertBefore(err, form.querySelector('button[type="submit"]'));
  }
  err.textContent = msg;
}
function clearFormError(formId) {
  document.getElementById(formId).querySelector('.form-error')?.remove();
}

// â”€â”€ Panel transitions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function showRoomPanel() {
  document.getElementById('setup-panel').classList.add('hidden');
  document.getElementById('room-panel').classList.remove('hidden');
}

// â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function initRoom() {
  initFirebase();

  const params = new URLSearchParams(window.location.search);
  const isJoin = params.get('join') === 'true';
  const preCode = (params.get('roomId') || '').toUpperCase();

  const tabCreate = document.getElementById('tab-create');
  const tabJoin   = document.getElementById('tab-join');
  const formCreate = document.getElementById('form-create');
  const formJoin   = document.getElementById('form-join');

  function showCreate() {
    tabCreate.classList.add('active'); tabJoin.classList.remove('active');
    formCreate.classList.remove('hidden'); formJoin.classList.add('hidden');
  }
  function showJoin() {
    tabJoin.classList.add('active'); tabCreate.classList.remove('active');
    formJoin.classList.remove('hidden'); formCreate.classList.add('hidden');
    if (preCode) document.getElementById('input-room-code').value = preCode;
  }

  tabCreate.addEventListener('click', showCreate);
  tabJoin.addEventListener('click', showJoin);
  if (isJoin || preCode) showJoin(); else showCreate();

  formCreate.addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('input-facilitator-name').value.trim();
    if (!name) return;
    clearFormError('form-create');
    createRoom(name);
  });

  formJoin.addEventListener('submit', e => {
    e.preventDefault();
    const name = document.getElementById('input-participant-name').value.trim();
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    if (!name || !code) return;
    clearFormError('form-join');
    joinRoom(code, name);
  });

  document.getElementById('form-add-story').addEventListener('submit', e => {
    e.preventDefault();
    const input = document.getElementById('story-input');
    const title = input.value.trim();
    if (!title) return;
    addStory(title);
    input.value = '';
  });

  document.getElementById('btn-reveal').addEventListener('click', revealVotes);
  document.getElementById('btn-reset').addEventListener('click', newRound);

  // Restore session on page refresh
  const session = getSession();
  if (session?.roomCode && session?.participantId) {
    currentParticipantId = session.participantId;
    currentRoomCode = session.roomCode;
    showRoomPanel();
    joinRoom(session.roomCode, ''); // will detect existing session and reconnect
  }
}

document.addEventListener('DOMContentLoaded', initRoom);
