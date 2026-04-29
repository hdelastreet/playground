// room.js — Phase 3: Multi-User Sync via Firebase Realtime Database
// No server needed — Firebase handles real-time sync across all computers.
//
// ── SETUP: replace the placeholder values below with your Firebase project config ──
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

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const SESSION_KEY = 'scrumestimate_session';

let db = null;
let currentParticipantId = null;
let currentRoomCode = null;
let activeRoomRef = null; // Firebase ref being listened to

// ── Firebase init ─────────────────────────────────────────────

function initFirebase() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();

  // Drive the connection status dot from Firebase's own connection state
  db.ref('.info/connected').on('value', snap => {
    setConnectionStatus(snap.val() ? 'connected' : 'disconnected');
  });
}

// ── Utilities ─────────────────────────────────────────────────

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

// ── Session persistence ────────────────────────────────────────

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(participantId, roomCode) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ participantId, roomCode }));
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// ── Firebase helpers ──────────────────────────────────────────

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

// ── Real-time subscription ─────────────────────────────────────

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

// ── Room Actions ───────────────────────────────────────────────

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

// ── Consensus ──────────────────────────────────────────────────

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

// ── Connection status ──────────────────────────────────────────

function setConnectionStatus(status) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot) return;
  dot.className = 'conn-dot ' + status;
  label.textContent = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Reconnecting…' }[status] || '';
}

// ── Rendering ──────────────────────────────────────────────────

function renderRoom(room) {
  const me = room.participants.find(p => p.id === currentParticipantId);
  const isFacilitator = !!(me && me.isFacilitator);
  const activeStory = room.stories.find(s => s.id === room.activeStoryId);

  document.getElementById('room-code-display').textContent = room.code;
  document.getElementById('active-story-title').textContent =
    activeStory ? activeStory.title : 'No active story — add one below';
  document.getElementById('facilitator-badge').classList.toggle('hidden', !isFacilitator);

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
        ? `<span class="vote-badge voted">✔</span>`
        : `<span class="vote-badge waiting">…</span>`;
    }

    const roleTag = p.isFacilitator ? `<span class="role-tag">host</span>` : '';
    const offlineTag = p.connected === false ? `<span class="offline-tag">offline</span>` : '';
    const kickBtn = (isFacilitator && p.id !== currentParticipantId)
      ? `<button class="btn-icon danger kick-btn" data-id="${escHtml(p.id)}" title="Remove participant">✕</button>`
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
      ? `<button class="btn-icon" data-action="activate" data-id="${escHtml(story.id)}" title="Set active">▶</button>`
      : '';
    const pointsBadge = isDone && story.points !== null
      ? `<span class="story-points-badge">${story.points}pt</span>` : '';
    li.innerHTML = `
      <span class="story-title-text">${escHtml(story.title)}</span>
      ${pointsBadge}
      <span class="story-item-actions">
        ${activateBtn}
        <button class="btn-icon danger" data-action="remove" data-id="${escHtml(story.id)}" title="Remove">✕</button>
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
      `<tr><td>${escHtml(p.name)}</td><td class="vote-cell">${escHtml(p.vote ?? '—')}</td></tr>`
    ).join('')}</tbody>
  `;

  const consensus = computeConsensus(room.participants.map(p => p.vote));
  if (consensus.level === 'no-votes') {
    indicator.innerHTML = `<span class="consensus-tag no-votes">No numeric votes cast</span>`;
  } else {
    const labels = { unanimous: '✔ Unanimous!', close: '~ Close', split: '⚠ Split' };
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

// ── Form errors ────────────────────────────────────────────────

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

// ── Panel transitions ─────────────────────────────────────────

function showRoomPanel() {
  document.getElementById('setup-panel').classList.add('hidden');
  document.getElementById('room-panel').classList.remove('hidden');
}

// ── Init ──────────────────────────────────────────────────────

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

const CARDS = ['0', '1', '2', '3', '5', '8', '13', '21', '?', '☕'];
const SESSION_KEY = 'scrumestimate_session';
// Point ws:// at the same hostname as the page, port 3000.
const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.hostname + ':3000';

// ── Client state ───────────────────────────────────────────────
let ws = null;
let currentParticipantId = null; // our identity (stored in sessionStorage)
let currentRoom = null;          // last full state snapshot from server
let reconnectTimer = null;
let reconnectDelay = 1000;
let pendingAction = null;        // { type, payload } to send once connected

// ── Utilities ──────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ── Session persistence (survives page refresh) ────────────────

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function saveSession(participantId, roomCode) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ participantId, roomCode }));
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ── WebSocket connection ───────────────────────────────────────

function connect(onOpen) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setConnectionStatus('connecting');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    setConnectionStatus('connected');
    if (onOpen) { onOpen(); onOpen = null; }
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConnectionStatus('disconnected');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    // 'close' will follow; no extra handling needed
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // If we were in a room, try to rejoin on reconnect
    const session = getSession();
    connect(session ? () => rejoinSession(session) : null);
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 16000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ── Server message handler ─────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'state':
      currentRoom = msg.room;
      if (!document.getElementById('room-panel').classList.contains('hidden') ||
          document.getElementById('setup-panel').classList.contains('hidden')) {
        renderRoom(currentRoom);
      } else {
        showRoomPanel();
      }
      break;
    case 'error':
      // Surface server errors back to the appropriate form
      if (document.getElementById('setup-panel') &&
          !document.getElementById('setup-panel').classList.contains('hidden')) {
        const activeForm = document.getElementById('form-join').classList.contains('hidden')
          ? 'form-create' : 'form-join';
        showFormError(activeForm, msg.message);
      }
      break;
    case 'kicked':
      clearSession();
      currentRoom = null;
      currentParticipantId = null;
      alert('You were removed from the room by the facilitator.');
      location.reload();
      break;
  }
}

// ── Room actions (client → server) ────────────────────────────

function createRoom(name) {
  currentParticipantId = generateId();
  saveSession(currentParticipantId, null); // code unknown until server responds
  connect(() => send({ type: 'create', name, participantId: currentParticipantId }));
}

function joinRoom(code, name) {
  currentParticipantId = generateId();
  saveSession(currentParticipantId, code);
  connect(() => send({ type: 'join', code, name, participantId: currentParticipantId }));
}

function rejoinSession(session) {
  currentParticipantId = session.participantId;
  send({ type: 'join', code: session.roomCode, name: '(reconnecting)', participantId: session.participantId });
}

function vote(value) { send({ type: 'vote', value }); }
function revealVotes() { send({ type: 'reveal' }); }
function newRound() { send({ type: 'new-round' }); }
function addStory(title) { send({ type: 'add-story', title }); }
function removeStory(storyId) { send({ type: 'remove-story', storyId }); }
function setActiveStory(storyId) { send({ type: 'set-active-story', storyId }); }
function confirmStory(points) { send({ type: 'confirm-story', points }); }
function kickParticipant(targetId) { send({ type: 'kick', targetId }); }

// ── Consensus ──────────────────────────────────────────────────

function computeConsensus(votes) {
  const numeric = votes
    .filter(v => v !== null && v !== '?' && v !== '☕')
    .map(Number)
    .filter(n => !isNaN(n));
  if (numeric.length === 0) return { avg: null, level: 'no-votes' };
  const avg = Math.round((numeric.reduce((a, b) => a + b, 0) / numeric.length) * 10) / 10;
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  let level;
  if (min === max) level = 'unanimous';
  else if (max - min <= 2) level = 'close';
  else level = 'split';
  return { avg, min, max, level };
}

// ── Connection status indicator ────────────────────────────────

function setConnectionStatus(status) {
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if (!dot) return;
  dot.className = 'conn-dot ' + status;
  label.textContent = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Reconnecting…' }[status] || '';
}

// ── Rendering ──────────────────────────────────────────────────

function renderRoom(room) {
  const me = room.participants.find(p => p.id === currentParticipantId);
  const isFacilitator = !!(me && me.isFacilitator);
  const activeStory = room.stories.find(s => s.id === room.activeStoryId);

  // Persist the room code in session now that we know it
  if (currentParticipantId) saveSession(currentParticipantId, room.code);

  // Header
  document.getElementById('room-code-display').textContent = room.code;
  document.getElementById('active-story-title').textContent =
    activeStory ? activeStory.title : 'No active story — add one below';
  document.getElementById('facilitator-badge').classList.toggle('hidden', !isFacilitator);

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
        ? `<span class="vote-badge voted">✔</span>`
        : `<span class="vote-badge waiting">…</span>`;
    }

    const roleTag = p.isFacilitator ? `<span class="role-tag">host</span>` : '';
    const offlineTag = p.connected === false ? `<span class="offline-tag">offline</span>` : '';

    // Kick button: shown only to facilitator, only for other participants
    const kickBtn = (isFacilitator && p.id !== currentParticipantId)
      ? `<button class="btn-icon danger kick-btn" data-id="${escHtml(p.id)}" title="Remove participant">✕</button>`
      : '';

    li.innerHTML = `
      <span class="participant-name">${escHtml(p.name)}${roleTag}${offlineTag}</span>
      <span class="participant-right">${voteHtml}${kickBtn}</span>
    `;
    ul.appendChild(li);
  });

  ul.querySelectorAll('.kick-btn').forEach(btn => {
    btn.addEventListener('click', () => kickParticipant(btn.dataset.id));
  });

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

  // Results panel
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
      ? `<button class="btn-icon" data-action="activate" data-id="${escHtml(story.id)}" title="Set active">▶</button>`
      : '';
    const pointsBadge = isDone && story.points !== null
      ? `<span class="story-points-badge">${story.points}pt</span>`
      : '';
    li.innerHTML = `
      <span class="story-title-text">${escHtml(story.title)}</span>
      ${pointsBadge}
      <span class="story-item-actions">
        ${activateBtn}
        <button class="btn-icon danger" data-action="remove" data-id="${escHtml(story.id)}" title="Remove">✕</button>
      </span>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'activate') setActiveStory(btn.dataset.id);
      if (btn.dataset.action === 'remove') removeStory(btn.dataset.id);
    });
  });
}

function renderResults(room, isFacilitator) {
  const table = document.getElementById('results-table');
  const indicator = document.getElementById('consensus-indicator');
  const btnConfirm = document.getElementById('btn-confirm-story');

  const rows = room.participants.map(p =>
    `<tr><td>${escHtml(p.name)}</td><td class="vote-cell">${escHtml(p.vote ?? '—')}</td></tr>`
  ).join('');
  table.innerHTML = `
    <thead><tr><th>Participant</th><th>Vote</th></tr></thead>
    <tbody>${rows}</tbody>
  `;

  const consensus = computeConsensus(room.participants.map(p => p.vote));
  if (consensus.level === 'no-votes') {
    indicator.innerHTML = `<span class="consensus-tag no-votes">No numeric votes cast</span>`;
  } else {
    const labels = { unanimous: '✔ Unanimous!', close: '~ Close', split: '⚠ Split' };
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

// ── Error display ─────────────────────────────────────────────

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
  const form = document.getElementById(formId);
  const err = form.querySelector('.form-error');
  if (err) err.remove();
}

// ── Panel transitions ─────────────────────────────────────────

function showRoomPanel() {
  document.getElementById('setup-panel').classList.add('hidden');
  document.getElementById('room-panel').classList.remove('hidden');
  if (currentRoom) renderRoom(currentRoom);
}

// ── Init ──────────────────────────────────────────────────────

function initRoom() {
  const params = new URLSearchParams(window.location.search);
  const isJoin = params.get('join') === 'true';
  const preCode = (params.get('roomId') || '').toUpperCase();

  const tabCreate = document.getElementById('tab-create');
  const tabJoin = document.getElementById('tab-join');
  const formCreate = document.getElementById('form-create');
  const formJoin = document.getElementById('form-join');

  function showCreate() {
    tabCreate.classList.add('active');
    tabJoin.classList.remove('active');
    formCreate.classList.remove('hidden');
    formJoin.classList.add('hidden');
  }

  function showJoin() {
    tabJoin.classList.add('active');
    tabCreate.classList.remove('active');
    formJoin.classList.remove('hidden');
    formCreate.classList.add('hidden');
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
  if (session && session.roomCode && session.participantId) {
    currentParticipantId = session.participantId;
    // Show room panel immediately (blank); it will populate once WS confirms
    document.getElementById('setup-panel').classList.add('hidden');
    document.getElementById('room-panel').classList.remove('hidden');
    connect(() => rejoinSession(session));
  }
}

document.addEventListener('DOMContentLoaded', initRoom);
