// firebase-core.js — everything the create, join and room pages all need.
//
// Loaded first on every page that talks to Firebase. It owns the connection,
// the anonymous identity, and the little bit of state that has to survive the
// hop from the create/join form to the room page.
//
// Access control lives in database.rules.json, not in this file. Everything the
// browser does here is assumed to be forgeable; the rules are what actually
// enforce "only the facilitator reveals" and "nobody reads a vote early".
//
// ―― SETUP: replace the placeholder values below with your Firebase project config ――

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCQYfUpOgKUw1sCdbXHc7zCav3SgSRE7Tg",
  authDomain: "estimateroom-97b7b.firebaseapp.com",
  databaseURL: "https://estimateroom-97b7b-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "estimateroom-97b7b",
  storageBucket: "estimateroom-97b7b.firebasestorage.app",
  messagingSenderId: "443595862572",
  appId: "1:443595862572:web:fafe0311a75d30c2c5d789"
};

const SESSION_KEY = 'scrumestimate_session';
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // rooms idle longer than this are abandoned

let db = null;
let currentParticipantId = null;
let currentRoomCode = null;
let currentUid = null;        // Firebase anonymous auth uid — the identity the rules trust
let authReady = null;         // Promise resolving once we are signed in

// Firebase initialization

function initFirebase() {
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  db = firebase.database();
}

// Anonymous sign-in. There is no login screen and nothing for the user to do —
// it just hands every browser a stable auth.uid so the rules have an identity to
// pin the facilitator to, and to scope each participant's writes to.
//
// The uid persists in local storage, which is what lets the create/join form
// hand off to the room page: the room page signs in as the same identity, so it
// still owns the participant node the form just wrote.
function ensureAuth() {
  if (authReady) return authReady;

  authReady = firebase.auth().signInAnonymously()
    .then(cred => { currentUid = cred.user.uid; return currentUid; })
    .catch(err => {
      authReady = null; // let the next attempt retry rather than caching a failure
      throw err;
    });
  return authReady;
}

function authErrorMessage(err) {
  const code = (err && err.code) || '';
  const detail = String((err && err.message) || '');

  // The API key can be restricted by HTTP referrer in the Google Cloud console.
  // The Realtime Database ignores the key entirely, so this only ever shows up
  // once something calls the auth API — which makes it easy to misread as a
  // rules problem. Name it explicitly.
  if (/referer|referrer/i.test(detail)) {
    return 'This origin is not on the API key\'s allowed-referrer list, so sign-in was refused. '
      + 'Google Cloud console → APIs & Services → Credentials → the Firebase browser key → Application restrictions.';
  }

  switch (code) {
    case 'auth/operation-not-allowed':
      return 'Sign-in is not enabled on this Firebase project. Enable the Anonymous provider in the Firebase console.';
    case 'auth/network-request-failed':
      return 'Could not reach Firebase. Check your network connection and try again.';
    case 'auth/api-key-not-valid':
    case 'auth/invalid-api-key':
      return 'The Firebase API key in js/firebase-core.js is not valid for this project.';
    default:
      return `Could not sign in to the estimation service${code ? ` (${code})` : ''}. Please try again.`;
  }
}

// Utilities

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

function isStale(meta) {
  return !meta || !meta.lastActiveAt || (Date.now() - meta.lastActiveAt) > ROOM_TTL_MS;
}

// Session persistence
//
// This is also the hand-off between pages: the create/join form writes the
// session, then navigates to the room page, which picks it up exactly the way it
// would after a refresh. One entry path into the room, not two.

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function saveSession(participantId, roomCode) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ participantId, roomCode }));
}
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// Firebase helpers

function rRef(path) { return db.ref(path); }
function serverTime() { return firebase.database.ServerValue.TIMESTAMP; }

// Keep the room out of the abandoned-room sweep. The rules only accept the
// server clock here, so this can neither backdate a room into expiry nor
// forge a timestamp to keep one alive past its last real use.
function touchRoom() {
  if (!currentRoomCode) return;
  rRef(`rooms/${currentRoomCode}/meta/lastActiveAt`).set(serverTime()).catch(() => {});
}

// Delete a room that has aged out. Any client may do this — the rules check the
// 24h threshold server-side — which is how abandoned rooms get collected
// without a backend or a scheduled job.
function sweepStaleRoom(code) {
  rRef(`rooms/${code}`).remove().catch(() => {});
}

// Collect rooms nobody is coming back to.
//
// The lazy sweep above only fires on a room someone re-enters, which for a
// meeting room is never: the tab closes and the code is never typed again. So
// the create page runs this on load instead — every new meeting collects the
// ones before it.
//
// The rules allow exactly this query against the room list and nothing else, so
// the parameters here are not a suggestion: change one and the read is denied.
// The margin absorbs a client clock running fast, which would otherwise push
// endAt past the window the rules allow.
const SWEEP_BATCH = 25;                    // must not exceed the rules' limitToFirst ceiling
const SWEEP_CLOCK_MARGIN_MS = 5 * 60 * 1000;

function sweepAbandonedRooms() {
  return rRef('rooms')
    .orderByChild('meta/lastActiveAt')
    .endAt(Date.now() - ROOM_TTL_MS - SWEEP_CLOCK_MARGIN_MS)
    .limitToFirst(SWEEP_BATCH)
    .once('value')
    .then(snap => { snap.forEach(child => { sweepStaleRoom(child.key); }); })
    .catch(() => {}); // housekeeping: a denied or offline sweep is not the user's problem
}
