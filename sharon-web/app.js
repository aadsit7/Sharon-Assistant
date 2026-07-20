// app.js — Sharon's orchestrator, as a WEB PAGE (converted from the Chrome
// extension's sidepanel.js). Wires the ears/voice (speech.js), the backend
// brain (api.js), and the UI (ui.js) into one conversation loop:
//
//   listen → live transcript streams into the presence card → (instant
//   command? do it locally) → adaptive silence countdown (tap to edit) →
//   assist() one round trip: Claude answers AND/OR reads-writes the Google
//   Sheet database through tools → answer cards in the thread (+ spoken-aloud
//   line) → undo toast → listen.
//
// What's different from the extension:
//   • No Chrome APIs. Settings, setup state and the session id live in
//     localStorage — the tiny storage helper below mirrors the exact shapes
//     chrome.storage.local gave the code, so everything around it is
//     unchanged.
//   • No page awareness and no on-page acting — a web page cannot see other
//     tabs, so no page context ever rides along (the backend tolerates an
//     empty page), and the tab pill / screen mode / scroll-and-act plumbing
//     is gone.
//   • No screen recording and no keyboard shortcuts — those lived in the
//     extension's background worker and offscreen document.
//   • NEW: the passphrase gate. The page is public, so the backend's shared
//     API_KEY is never in the code — the visitor types it once and it lives
//     only in their own browser (config.js's getApiKey reads it fresh per
//     request); a server "unauthorized" clears it and brings the gate back.
//
// Kept working exactly as before: the full voice conversation loop with
// barge-in (speech.js's echo protection included), typing in the composer,
// the voice-memo recorder (records right here via MediaRecorder and uploads
// to Drive through api.saveRecording), playback of saved recordings, the
// memory view, and the notes view (notes, sections, dictation).

import { HISTORY_TURNS, PROXY_URL, getApiKey } from "./config.js";
import * as api from "./api.js";
import * as speech from "./speech.js";
import * as ui from "./ui.js";
import * as notes from "./notes.js";
import { MODES, initModes, enterMode, inMode } from "./mode.js";

/* ------------------------------------------------------------------ *
 * localStorage-backed storage — a stand-in for chrome.storage.local
 * with the same shapes: get("k") resolves to { k: value }, set({ k: v })
 * writes each pair (as JSON), so the calling code reads unchanged.
 * ------------------------------------------------------------------ */
const storage = {
  async get(keys) {
    const out = {};
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      try {
        const raw = localStorage.getItem(k);
        if (raw != null) out[k] = JSON.parse(raw);
      } catch (_) {
        /* an unreadable entry reads as missing */
      }
    }
    return out;
  },
  async set(obj) {
    for (const [k, v] of Object.entries(obj || {})) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch (_) {
        /* storage full or blocked — carry on without persisting */
      }
    }
  },
};

/* ------------------------------------------------------------------ *
 * Passphrase gate — the page is public; the backend is not.
 * The visitor's passphrase (the backend's shared API_KEY) lives ONLY in
 * their browser's localStorage under "sharon_api_key"; api.js reads it
 * fresh on every request. Until it exists, the overlay in index.html
 * covers the app and init() waits at ensureApiKey(). If the server ever
 * answers "unauthorized" — a wrong or since-changed key — the stored key
 * is cleared and the overlay comes back so it can be re-entered.
 * ------------------------------------------------------------------ */
const API_KEY_STORAGE = "sharon_api_key";
const gateEls = {
  overlay: document.getElementById("gateOverlay"),
  form: document.getElementById("gateForm"),
  input: document.getElementById("gateInput"),
  err: document.getElementById("gateErr"),
};
let gateWaiters = []; // resolvers awaiting an unlock

function gateOpen() {
  return !!(gateEls.overlay && !gateEls.overlay.classList.contains("hidden"));
}

function showGate(message) {
  if (!gateEls.overlay) return;
  if (gateEls.err) {
    gateEls.err.textContent = message || "";
    gateEls.err.classList.toggle("hidden", !message);
  }
  gateEls.overlay.classList.remove("hidden");
  if (gateEls.input) {
    gateEls.input.value = "";
    gateEls.input.focus();
  }
}

function hideGate() {
  if (gateEls.overlay) gateEls.overlay.classList.add("hidden");
}

// Resolves immediately when a key is already stored; otherwise shows the
// overlay and resolves once the visitor unlocks. init() awaits this before
// anything talks to the backend.
function ensureApiKey() {
  if (getApiKey()) return Promise.resolve();
  showGate();
  return new Promise((resolve) => gateWaiters.push(resolve));
}

function unlockSubmitted(ev) {
  ev.preventDefault();
  const key = gateEls.input ? gateEls.input.value.trim() : "";
  if (!key) return;
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch (_) {
    /* storage blocked — the key just won't survive a reload */
  }
  hideGate();
  const waiters = gateWaiters;
  gateWaiters = [];
  for (const w of waiters) w();
}
if (gateEls.form) gateEls.form.addEventListener("submit", unlockSubmitted);

// The server rejected the key: clear it and ask again.
function onAuthRejected() {
  try {
    localStorage.removeItem(API_KEY_STORAGE);
  } catch (_) {
    /* ignore */
  }
  if (!gateOpen())
    showGate("That passphrase didn't work — the server turned it down. Enter it again to reconnect.");
}

// Sniff backend replies for the auth rejection AT THE TRANSPORT, so it
// catches every caller (this file, notes.js, all of api.js) without
// changing api.js beyond its one key-reading edit. Only PROXY_URL requests
// are inspected, and only small { ok:false } bodies are matched, so normal
// replies — including multi-megabyte recording audio — pass through
// untouched.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url === PROXY_URL) {
    try {
      const len = Number(res.headers.get("content-length") || 0);
      if (len < 4096) {
        const raw = await res.clone().text();
        if (raw.length < 4096 && raw.indexOf('"ok":false') !== -1 && /unauthorized/i.test(raw)) {
          onAuthRejected();
        }
      }
    } catch (_) {
      /* not ours to judge — api.js reports the real error */
    }
  }
  return res;
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
const SETTINGS_KEY = "sharon_settings";
// The page-related toggles (autoRead / allowScroll / allowActions /
// confirmActions) are kept so Settings stays familiar and the stored shape
// matches the extension's, but they have no effect on a web page — there is
// no tab for Sharon to read, scroll, or act on here.
const DEFAULT_SETTINGS = {
  autoRead: false, // read pages automatically on tab change (extension only)
  allowScroll: true, // may Sharon scroll the active tab? (extension only)
  readAloud: true, // speak answers out loud?
  allowActions: false, // may Sharon click/type/act on the page? (extension only)
  confirmActions: true, // ask for a spoken "yes" before each set of actions
  voiceName: "",
  voiceRate: 0.95,
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const stored = await storage.get(SETTINGS_KEY);
    const saved = stored && stored[SETTINGS_KEY];
    if (saved && typeof saved === "object") settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch (_) {
    /* keep defaults */
  }
}
async function saveSettings() {
  try {
    await storage.set({ [SETTINGS_KEY]: settings });
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * First-run setup — mic → connect memory → say hello.
 * Lives in the welcome view once ever, then as status rows in Settings.
 * ------------------------------------------------------------------ */
const SETUP_KEY = "sharon_setup";
let setup = { mic: false, memory: false, hello: false };

function setupComplete() {
  return setup.mic && setup.memory && setup.hello;
}
async function loadSetup() {
  try {
    const stored = await storage.get(SETUP_KEY);
    const saved = stored && stored[SETUP_KEY];
    if (saved && typeof saved === "object") setup = { ...setup, ...saved };
  } catch (_) {
    /* keep defaults */
  }
}
function markSetup(step) {
  if (setup[step]) return;
  setup[step] = true;
  try {
    storage.set({ [SETUP_KEY]: setup });
  } catch (_) {
    /* ignore */
  }
  refreshWelcomeSteps();
  refreshSetupRows();
  if (setupComplete() && ui.welcomeVisible()) ui.hideWelcome();
}

// Welcome step states: done steps get checks, the first open step is active.
function refreshWelcomeSteps() {
  const order = ["mic", "memory", "hello"];
  let activeGiven = false;
  for (const step of order) {
    if (setup[step]) {
      ui.setWelcomeStep(step, "done");
    } else if (!activeGiven) {
      activeGiven = true;
      ui.setWelcomeStep(step, "active");
    } else {
      ui.setWelcomeStep(step, "pending");
    }
  }
}

function refreshSetupRows() {
  ui.setSetupRow("mic", setup.mic, setup.mic ? "Allowed — Sharon can hear you" : "Not allowed yet");
  ui.setSetupRow(
    "memory",
    setup.memory,
    setup.memory ? "“Speaking Assistant” Sheet · connected" : "Not connected yet"
  );
  ui.setSetupRow("hello", setup.hello, setup.hello ? "Done — you two have met" : "You two haven't met yet");
}

// The mic step ticks only when permission is really granted (or when we
// actually hear the user — proof positive the mic works).
async function watchMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    const check = () => {
      if (status.state === "granted") markSetup("mic");
      updateStatus();
    };
    status.addEventListener("change", check);
    check();
  } catch (_) {
    /* the "heard you" path still covers it */
  }
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */
let sessionId = null;
let busy = false; // a request is in flight
let abortController = null;

// The mode-bar buttons (mic / record) can kick off async work (opening the
// mic stream) BEFORE the mode actually changes. Without a lock, a second
// tap — the same button again, or a different one — slips through that
// async gap and overlaps the first, which is exactly what made switching
// between them feel flaky. Every mode-button action runs through
// runModeAction(), so only one is ever in flight and taps never interleave.
let modeActionBusy = false;
async function runModeAction(fn) {
  if (modeActionBusy) return; // a transition is already settling — ignore the tap
  modeActionBusy = true;
  try {
    await fn();
  } catch (_) {
    // A thrown action must never wedge the lock; the mode manager already
    // lands in a clean LISTENING state on any enter/exit failure.
  } finally {
    modeActionBusy = false;
    updateStatus();
  }
}

// A quiet, non-spoken confirmation line — used to answer a tap that can't do
// what it normally would right now, so a button never feels dead.
function hint(label) {
  ui.showUndoToast({ label });
}

// Conversation history — the panel's short-term memory.
let history = []; // [{role:"user"|"assistant", content}]
function remember(role, content) {
  const c = (content || "").trim();
  if (!c) return;
  history.push({ role, content: c.slice(0, 4000) });
  if (history.length > HISTORY_TURNS * 2) history = history.slice(-HISTORY_TURNS * 2);
}

/* ------------------------------------------------------------------ *
 * Mode-owned state — the manager (mode.js) is the single source of truth
 * for WHICH mode Sharon is in; these hold what each mode carries with it.
 * ------------------------------------------------------------------ */
let searchAc = null; // SEARCHING: the in-flight call the mode may cancel
let preparedRec = null; // RECORDING: MediaRecorder staged for the enter routine

function uuid() {
  return (
    (crypto.randomUUID && crypto.randomUUID()) ||
    "id-" + Math.random().toString(36).slice(2) + Date.now()
  );
}

async function ensureSessionId() {
  if (sessionId) return sessionId;
  try {
    const { sharon_session_id } = await storage.get("sharon_session_id");
    if (sharon_session_id) {
      sessionId = sharon_session_id;
    } else {
      sessionId = uuid();
      await storage.set({ sharon_session_id: sessionId });
    }
  } catch (_) {
    sessionId = "sess-" + Math.random().toString(36).slice(2) + Date.now();
  }
  return sessionId;
}

/* ------------------------------------------------------------------ *
 * Status line — single source of truth for the header
 * ------------------------------------------------------------------ */
let thinking = false;
let hearing = false; // interim speech is actively streaming

function updateStatus() {
  const micLive = !speech.isMicMuted() && !speech.isMicBlocked();
  ui.setMicIndicator(micLive);
  ui.setVoiceIndicator(!!settings.readAloud);

  // The header follows the mode manager first — the status text and the
  // mode bar must never disagree about what Sharon is doing.
  if (recActive()) ui.setPhase("recording");
  else if (inMode(MODES.SEARCHING)) ui.setPhase("searching");
  else if (thinking || busy) ui.setPhase("thinking");
  else if (speech.isSpeaking()) ui.setPhase("speaking");
  else if (hearing && micLive) ui.setPhase("hearing");
  else if (!micLive) ui.setPhase("muted");
  else ui.setPhase("listening");

  // Sharon's voice and a playing recording never overlap — every state
  // change re-checks the pair (see syncPlaybackWithSpeech).
  syncPlaybackWithSpeech();
}

// Speak + show a short local note from Sharon (no server round trip).
// Remembered like any reply: if the user answers "yes" to something Sharon
// said locally, the model must see what it was.
function sharonSay(text) {
  ui.addSharonBubble(text);
  remember("assistant", text);
  speech.speak(text, { onDone: updateStatus });
}

// The redeploy walkthrough for a stale Apps Script deployment. Pasting new
// code into the editor is not enough — /exec serves the version pinned to
// the deployment, so backend/Code.gs changes only go live via "New version".
const REDEPLOY_STEPS =
  "Your connection and passphrase are fine — the deployment itself is just out of date. " +
  "Open your “Speaking Assistant” Sheet → Extensions → Apps Script, replace the project's code " +
  "with the latest backend/Code.gs, then choose Deploy → Manage deployments → " +
  "edit (✏️) → Version: “New version” → Deploy. The web-app URL stays the same, so nothing else changes.";

function nextStepFor(err) {
  if (err && err.backendOutdated) return REDEPLOY_STEPS;
  return (
    "Check your internet connection and try again. If the server rejected your passphrase, " +
    "the unlock screen comes back on its own so you can re-enter it."
  );
}

// Every error says what happened AND what to do next. During first-run
// setup, problems surface as checklist guidance instead of thread noise.
function reportProblem(msg, nextStep) {
  if (!setupComplete() && ui.welcomeVisible()) {
    ui.setWelcomeStep("memory", "active", msg + " " + (nextStep || ""));
    return;
  }
  const text = "I hit a snag: " + msg + (nextStep ? "\nWhat to do next: " + nextStep : "");
  ui.addSharonBubble(text);
  remember("assistant", text);
}

/* ------------------------------------------------------------------ *
 * The capture pipeline — stream → adaptive silence → (edit) → send → undo
 * ------------------------------------------------------------------ */
// Adaptive end-of-speech: after your last words, the transcript is sent once
// the mic stays silent this long. Tune both windows here.
const SILENCE_COMPLETE_MS = 800; // what you said reads as a finished thought
const SILENCE_UNFINISHED_MS = 1400; // trailing "and…", "um…", a dangling clause
const HEARING_DECAY_MS = 1200;

// Trailing words that signal a thought still in flight (conjunctions,
// fillers, articles, possessives — kept conservative on purpose).
const UNFINISHED_TAIL = new Set([
  "and", "or", "but", "so", "because", "then", "also", "plus",
  "um", "uh", "er", "hmm", "like",
  "the", "a", "an", "my", "your", "his", "her", "their", "our", "its",
  "to", "if", "when", "while", "although", "though",
]);

function looksUnfinished(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (/[,\-–—:]$/.test(t)) return true; // a dangling clause
  const last = t.toLowerCase().replace(/[.!?]+$/g, "").split(/\s+/).pop();
  return UNFINISHED_TAIL.has(last);
}

let pendingText = ""; // committed finals awaiting send
let pendingConf = null;
let editing = false;
let hearingTimer = null;

function resetCapture() {
  pendingText = "";
  pendingConf = null;
  editing = false;
  hearing = false;
  if (hearingTimer) {
    clearTimeout(hearingTimer);
    hearingTimer = null;
  }
  ui.liveClear();
  ui.setCapture("idle");
  updateStatus();
}

function onInterimHeard(text) {
  markSetup("mic");
  hearing = true;
  if (hearingTimer) clearTimeout(hearingTimer);
  hearingTimer = setTimeout(() => {
    hearing = false;
    hearingTimer = null;
    // Words were heard but never finalized (interim that went quiet) — don't
    // let a captured message sit forever without its send countdown.
    if (pendingText && !editing && ui.els.html.getAttribute("data-capture") !== "counting") {
      startCountdown();
    }
    updateStatus();
  }, HEARING_DECAY_MS);
  if (editing) return; // the user took the keyboard — don't fight them
  ui.liveHideStrip();
  ui.setCapture("hearing");
  ui.liveTranscript(pendingText, text);
  updateStatus();
}

function startCountdown() {
  // Fast when the thought sounds complete, patient when it sounds unfinished.
  const wait = looksUnfinished(pendingText) ? SILENCE_UNFINISHED_MS : SILENCE_COMPLETE_MS;
  ui.setCapture("counting");
  ui.liveTranscript(pendingText, "");
  ui.liveShowStrip(wait, () => commitPending(true));
}

function openEditor() {
  editing = true;
  ui.setCapture("editing");
  ui.liveOpenEditor(pendingText);
  updateStatus();
}

function commitPending(auto) {
  // Voice captured around a recording is DROPPED, never queued — the seal
  // in speech.js keeps new words out; this drops anything already pending.
  if (recActive() || !speech.recorderSealOpen()) {
    resetCapture();
    return;
  }
  const text = pendingText.trim();
  const conf = pendingConf;
  resetCapture();
  if (!text) return;
  const turnEl = ui.addUserTurn(text, { spoken: true });
  sendTurn(text, { raw: text, conf });
  if (auto) {
    ui.showUndoToast({
      label: "Sent what I heard",
      onUndo: () => undoTurn(turnEl, text),
    });
  }
}

// Undo cancels the pending answer and returns the text to the composer.
function undoTurn(turnEl, text) {
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  ui.removeCard(turnEl);
  if (ui.els.composerInput) {
    ui.els.composerInput.value = text;
    ui.setComposerHasText(true);
    ui.els.composerInput.focus();
  }
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * Instant, hands-free commands — handled locally, zero latency
 * ------------------------------------------------------------------ */
function tryImmediateCommand(text, cmd) {
  if (cmd === "stop" || cmd === "stop reading" || cmd === "be quiet" || cmd === "quiet") {
    speech.stopSpeaking();
    // Interrupting a live web search cancels the in-flight call — the
    // turn's finally block then lands the mode back in LISTENING.
    if (inMode(MODES.SEARCHING) && abortController) {
      try {
        abortController.abort();
      } catch (_) {
        /* ignore */
      }
    }
    thinking = false;
    updateStatus();
    return true;
  }
  if (cmd === "pause") {
    speech.pauseSpeaking();
    return true;
  }
  if (cmd === "resume" || cmd === "continue" || cmd === "keep going" || cmd === "go on") {
    speech.resumeSpeaking();
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Routing every final utterance
 * ------------------------------------------------------------------ */
function handleUserUtterance(text, conf, { typed = false } = {}) {
  text = (text || "").trim();
  if (!text) return;

  // The recorder seal, end to end: while the recorder is anything but idle
  // (or trailing recording audio is still in its grace window), voice can
  // never become a message. speech.js already swallows recognition results;
  // this guards every other way in. Typed composer messages still work —
  // they're deliberate keyboard input, not leaked audio.
  if (!typed && (recActive() || !speech.recorderSealOpen())) {
    resetCapture();
    return;
  }

  // The user is addressing Sharon. If the Notes view is covering the thread
  // (it hides the presence card and composer too), close it back to the
  // conversation first — the same path as its back button, so an open edited
  // note still auto-saves — because a reply must never render invisibly.
  notes.closeNotesView();

  const cmd = text.toLowerCase().replace(/[.!?,]+$/g, "").trim();

  // Instant commands fire immediately and never enter the transcript.
  if (tryImmediateCommand(text, cmd)) {
    if (!typed) resetCapture();
    return;
  }

  // Typed text was written deliberately — it sends straight away, through
  // the exact same pipeline as speech.
  if (typed) {
    ui.addUserTurn(text, { spoken: false });
    sendTurn(text, {});
    return;
  }

  // Spoken text: while the editor is open, new words join the draft.
  if (editing) {
    if (ui.els.lcEditArea) ui.els.lcEditArea.value = (ui.els.lcEditArea.value + " " + text).trim();
    return;
  }

  // Otherwise accumulate and (re)start the visible auto-send countdown.
  pendingText = pendingText ? pendingText + " " + text : text;
  // Overall confidence for the utterance = its weakest segment, so the
  // backend's asr_confidence flow keeps flagging shaky transcripts.
  if (conf != null && !Number.isNaN(conf))
    pendingConf = pendingConf == null ? conf : Math.min(pendingConf, conf);
  startCountdown();
  updateStatus();
}

/* ------------------------------------------------------------------ *
 * The main turn — one assist() round trip
 * ------------------------------------------------------------------ */
async function sendTurn(userText, { raw = "", conf = null, showAsUser = true } = {}) {
  userText = (userText || "").trim();
  if (!userText) return;

  if (speech.isSpeaking()) speech.stopSpeaking();
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  const ac = new AbortController();
  abortController = ac;

  // The mode manager settles this turn's mode up front. Search-intent
  // phrasing lights SEARCHING until the reply arrives. A typed message
  // during RECORDING never touches the mode: the recorder keeps the ears
  // until its whole flow is done.
  const searchIntent = isSearchIntent(userText);
  if (!recActive()) {
    enterMode(searchIntent ? MODES.SEARCHING : MODES.LISTENING);
    if (searchIntent) searchAc = ac;
  }

  busy = true;
  thinking = true;
  updateStatus();

  const think = ui.addThinkingBubble();

  try {
    const id = await ensureSessionId();

    // A web page cannot see other tabs, so no page context ever rides
    // along — the backend tolerates an empty page and answers from the
    // conversation and the Sheet.
    const result = await api.assist(
      {
        sessionId: id,
        userText,
        history,
        page: {},
        agent: null,
        asrConfidence: conf,
        transcriptRaw: raw,
        clientMsgId: uuid(),
      },
      ac.signal
    );
    if (ac.signal.aborted) {
      ui.removeCard(think);
      return;
    }
    ui.removeCard(think);
    ui.dismissToast();

    markSetup("memory");
    if (showAsUser) markSetup("hello");

    if (showAsUser) remember("user", userText);
    else remember("user", userText.length > 200 ? userText.slice(0, 200) : userText);
    remember("assistant", result.reply || "");

    const webCard = renderEvents(userText, result.events || []);

    renderAndSpeakReply(result.reply, {
      question: showAsUser ? userText : "",
      webCard,
    });
  } catch (err) {
    ui.removeCard(think);
    if (err && err.name === "AbortError") return;
    reportProblem(err && err.message ? err.message : "I couldn't reach the server.", nextStepFor(err));
  } finally {
    if (abortController === ac) {
      busy = false;
      abortController = null;
      // The search settled (reply, error, or abort) — null searchAc FIRST so
      // SEARCHING's exit routine doesn't try to cancel a finished call.
      if (searchAc === ac) searchAc = null;
      if (inMode(MODES.SEARCHING)) enterMode(MODES.LISTENING);
    }
    thinking = false;
    updateStatus();
  }
}

/* --------- rendering Sharon's side of the turn --------- */
// SEARCHING is automatic, never tapped: this heuristic lights the globe the
// moment a search-shaped request goes out, and the backend's web_search
// event (the "From the web" card with sources) is the ground truth that a
// search really ran. Kept conservative — "search my notes" is memory work,
// not the web.
function isSearchIntent(text) {
  const t = (text || "").toLowerCase();
  if (/\b(my|your)\s+(notes?|memory|memories|tasks?|sheet|recordings?)\b/.test(t)) return false;
  return (
    /\b(search|google|look\s+(it\s+)?up)\b/.test(t) ||
    /\b(what'?s|find|get|check)\s+the\s+latest\b/.test(t) ||
    /\blatest\s+(on|news|about)\b/.test(t) ||
    /\b(news|headlines)\s+(about|on|of|for)\b/.test(t) ||
    /\bon\s+the\s+(web|internet)\b/.test(t)
  );
}

function domainsIn(text) {
  const out = [];
  const re = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|gov|edu|co|dev|app|ai))\b/gi;
  let m;
  while ((m = re.exec(text || ""))) {
    const d = m[1].toLowerCase().replace(/^www\./, "");
    if (!out.includes(d)) out.push(d);
    if (out.length >= 3) break;
  }
  return out;
}

// Displayed layer: pick the card the reply deserves. Spoken layer: the quiet
// italic line under the card with what Sharon actually says aloud.
function renderAndSpeakReply(reply, { question, webCard } = {}) {
  const text = (reply || "").trim();
  if (!text) return;

  let card = null;
  if (webCard) {
    // Web search already rendered the displayed layer (question → bullets →
    // clickable sources); Sharon's natural explanation attaches beneath it.
    card = webCard;
  } else {
    const facts = ui.extractFacts(text);
    if (facts) {
      card = ui.addLookedUpCard({
        question: question || "",
        answer: facts.rest,
        tiles: facts.tiles,
        chips: domainsIn(text),
      });
    }
  }

  if (card) {
    // Two-layer rule: card = scannable; spoken line = what she says aloud.
    if (settings.readAloud) ui.attachSpokenLine(card, text);
  } else {
    ui.addSharonBubble(text);
  }
  speech.speak(text, { onDone: updateStatus });
}

// Turn the backend's tool events into thread cards. Returns the web results
// card when one was created, so the reply renderer can attach Sharon's
// spoken line to it instead of building a second card.
function renderEvents(userText, events) {
  let webCard = null;
  for (const e of events) {
    if (!e || !e.ok || !e.data) continue;
    const d = e.data;
    if (d.kind === "web_search") {
      webCard = ui.addWebSearchCard({
        question: d.question || userText,
        bullets: Array.isArray(d.bullets) ? d.bullets : [],
        sources: Array.isArray(d.sources) ? d.sources : [],
      });
    } else if (d.kind === "saved") {
      const isTask = d.entry_type === "task";
      const cap = ui.addQuietCapture({
        title: "Captured quietly — no reply needed",
        sub: "Filed under " + (isTask ? "tasks" : "notes") + " in your Sheet",
        onUndo: d.entry_id
          ? async () => {
              try {
                await api.updateMemory({ entryId: d.entry_id, deleted: true });
                cap.markRemoved();
                refreshMemoryCount();
              } catch (err) {
                reportProblem(
                  "I couldn't remove that from your Sheet.",
                  "Check your connection, then delete it from Sharon's memory (the book icon)."
                );
              }
            }
          : null,
      });
      refreshMemoryCount();
    } else if (d.kind === "found" && Array.isArray(d.hits) && d.hits.length) {
      const hits = d.hits;
      if (hits.every((h) => h.entry_type === "task")) {
        ui.addTasksCard({ hits, onToggle: toggleTaskFromCard });
      } else {
        ui.addNotesCard({
          question: userText,
          hits,
          onRowTap: () => {
            ui.openMemory();
            loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
          },
          onListen: (h) => playRecordingFromHit(h),
        });
      }
    } else if (d.kind === "recordings_list") {
      ui.addRecordingsListCard({
        recordings: Array.isArray(d.recordings) ? d.recordings : [],
        onListen: (h) => playRecordingFromHit(h),
        onOpenAll: () => {
          memShowingRecordings = true;
          ui.selectFilter("recordings");
          ui.openMemory();
          loadRecordings();
        },
      });
    } else if (d.kind === "updated") {
      const p = d.patch || {};
      ui.addQuietCapture({
        title: p.deleted
          ? "Deleted from your Sheet"
          : p.status === "done"
          ? "Marked that task done"
          : "Updated in your Sheet",
        sub: "Synced with your Google Sheet",
      });
      refreshMemoryCount();
    }
    // "summarized" needs no card — the summary IS the spoken reply.
  }
  return webCard;
}

// Live checkboxes on the YOUR TASKS card — optimistic, then write back.
async function toggleTaskFromCard(h, row, check) {
  const wasDone = String(h.status) === "done";
  ui.setTaskRowDone(row, check, !wasDone);
  try {
    await api.updateMemory({ entryId: h.entry_id, status: wasDone ? "open" : "done" });
    h.status = wasDone ? "open" : "done";
    refreshMemoryCount();
  } catch (err) {
    ui.setTaskRowDone(row, check, wasDone);
    reportProblem("I couldn't update that task.", "Check your connection and tap the box again.");
  }
}

/* ------------------------------------------------------------------ *
 * Memory view — the Sheet, browsable and editable
 * ------------------------------------------------------------------ */
let memReqSeq = 0;

// Blue badge on the book icon = open-task count, refreshed quietly.
async function refreshMemoryCount() {
  try {
    const hits = await api.searchMemory({ query: "", limit: 25, touch: false });
    if (!Array.isArray(hits)) return;
    markSetup("memory");
    const openTasks = hits.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
    ui.setMemBadge(openTasks);
  } catch (_) {
    /* leave the badge as it was */
  }
}

// What the memory view is showing right now — the batch actions edit this
// list optimistically and re-render, instead of re-fetching the Sheet.
let memHits = [];
let memAtLimit = false;
let memHadQuery = false;

function memCallbacks() {
  return {
    onToggleDone: async (h) => {
      try {
        await api.updateMemory({
          entryId: h.entry_id,
          status: String(h.status) === "done" ? "open" : "done",
        });
        loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
      } catch (e) {
        ui.memError(
          "Couldn't update that: " + ((e && e.message) || e) + " — check your connection and tap it again."
        );
      }
    },
    onDelete: async (h) => {
      try {
        const res = await api.updateMemory({ entryId: h.entry_id, deleted: true });
        // A current backend deletes and returns updated:true. An older
        // deployment that predates recording deletes accepts the call but
        // returns updated:false / readonly — surface that honestly instead
        // of silently leaving the recording in place.
        if (res && res.updated === false) {
          warnRecordingDeleteUnsupported();
          return;
        }
        reloadMemoryView(); // recordings and notes each reload their own list
        refreshMemoryCount();
      } catch (e) {
        ui.memError(
          "Couldn't delete that: " + ((e && e.message) || e) + " — check your connection and try again."
        );
      }
    },
    onListen: (h) => playRecordingFromHit(h),
    onBatchStatus: (hits, status) => batchStatusSelected(hits, status),
    onBatchDelete: (hits) => batchDeleteSelected(hits),
  };
}

async function loadMemory(query) {
  const seq = ++memReqSeq;
  ui.memLoading();
  try {
    const hits = await api.searchMemory({ query: query || "", limit: 25, touch: false });
    if (seq !== memReqSeq) return;
    markSetup("memory");
    const list = Array.isArray(hits) ? hits : [];
    memHits = list;
    memHadQuery = !!(query || "").trim();
    memAtLimit = list.length >= 25;
    if (!memHadQuery) {
      ui.setMemorySubtitle(list.length, memAtLimit);
      const openTasks = list.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
      ui.setMemBadge(openTasks);
    }
    ui.memorySyncedNow();
    ui.renderMemory(memHits, memCallbacks());
  } catch (e) {
    if (seq !== memReqSeq) return;
    ui.memError("I couldn't load your Sheet — check your connection, then try the search again.");
  }
}

// True while the memory view is showing the Recordings filter — the one
// filter whose data comes from the recordings sheet, not the memory list, so
// leaving it (or searching) needs a reload of the normal memory entries.
let memShowingRecordings = false;

// Load every saved recording into the memory view (newest first). Shares
// memReqSeq with loadMemory so switching filters quickly never renders a
// stale response over a newer one.
async function loadRecordings() {
  const seq = ++memReqSeq;
  ui.memLoading();
  try {
    const recs = await api.listRecordings({ limit: 100 });
    if (seq !== memReqSeq) return;
    markSetup("memory");
    const list = Array.isArray(recs) ? recs : [];
    memHits = list;
    memHadQuery = false;
    memAtLimit = false;
    ui.setRecordingsSubtitle(list.length);
    ui.memorySyncedNow();
    ui.renderMemory(memHits, memCallbacks());
  } catch (e) {
    if (seq !== memReqSeq) return;
    ui.memError("I couldn't load your recordings — check your connection, then try again.");
  }
}

// The memory view's filter pills. Recordings needs its own source; every
// other filter is a client-side re-slice of the already-loaded list. Return
// true when we take over loading so ui.js doesn't also re-render.
function onMemFilterChange(filter) {
  if (filter === "recordings") {
    memShowingRecordings = true;
    loadRecordings();
    return true;
  }
  if (memShowingRecordings) {
    // Coming back from Recordings — reload the normal memory entries.
    memShowingRecordings = false;
    loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
    return true;
  }
  return false; // pure client-side filter — let ui.js re-slice
}

// Reload whichever list the memory view is currently showing — recordings
// have their own source, so a single delete/edit must refresh the right one.
function reloadMemoryView() {
  if (memShowingRecordings) loadRecordings();
  else loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
}

// Keep the "N things saved" subtitle and the open-task badge honest after an
// optimistic batch edit — no extra round trip unless a search is filtering
// the list (then the local list can't stand in for the whole Sheet).
function updateMemMeta() {
  if (memShowingRecordings) {
    ui.setRecordingsSubtitle(memHits.length);
    return;
  }
  if (memHadQuery) {
    refreshMemoryCount();
    return;
  }
  ui.setMemorySubtitle(memHits.length, memAtLimit && memHits.length >= 25);
  const openTasks = memHits.filter((h) => h.entry_type === "task" && String(h.status) !== "done").length;
  ui.setMemBadge(openTasks);
}

/* --------- bulk actions from selection mode --------- */
// Mark complete / Reopen — optimistic: every selected task flips at once,
// the whole batch goes up in ONE round trip, and anything the backend
// couldn't update flips back.
async function batchStatusSelected(hits, status) {
  const targets = hits.filter((h) => h.entry_id);
  if (!targets.length) return;
  const prev = new Map(targets.map((h) => [h, h.status]));
  targets.forEach((h) => {
    h.status = status;
  });
  ui.exitMemSelect();
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(targets.map((h) => ({ entryId: h.entry_id, status })));
    const results = (res && res.results) || [];
    const failedIds = new Set(results.filter((r) => r && !r.ok).map((r) => String(r.entry_id)));
    const failed = targets.filter((h) => failedIds.has(String(h.entry_id)));
    if (failed.length) {
      failed.forEach((h) => {
        h.status = prev.get(h);
      });
      ui.renderMemory(memHits, memCallbacks());
    }
    updateMemMeta();
    ui.memorySyncedNow();
    const okCount = targets.length - failed.length;
    ui.showUndoToast({
      label: failed.length
        ? okCount + " updated, " + failed.length + " skipped"
        : status === "done"
        ? "Marked " + okCount + " complete"
        : "Reopened " + okCount,
    });
  } catch (err) {
    targets.forEach((h) => {
      h.status = prev.get(h);
    });
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't update — check your connection." });
  }
}

// The one message for "this backend can't delete recordings yet": a visible
// toast over the memory view plus the full redeploy steps in the thread.
// Deleting is a server operation, so the only fix is updating the Apps
// Script deployment to the latest backend/Code.gs.
function warnRecordingDeleteUnsupported() {
  ui.showUndoToast({
    label: "Deleting recordings needs the latest backend — update your Apps Script.",
    duration: 7000,
  });
  reportProblem(
    "I can't delete recordings yet — your Google Apps Script backend is an older version that doesn't support it.",
    REDEPLOY_STEPS
  );
}

// Bulk delete with one Undo for the whole batch. The Sheet's delete is a
// soft flag (deleted = TRUE) for notes/tasks and recordings alike, so Undo
// simply re-sends the same batch with deleted:false and every row comes back
// (a deleted recording's audio is trashed and restored the same way).
async function batchDeleteSelected(hits) {
  const targets = hits.filter((h) => h.entry_id);
  if (!targets.length) return;
  const removed = targets
    .map((h) => ({ h, index: memHits.indexOf(h) }))
    .filter((x) => x.index >= 0)
    .sort((a, b) => a.index - b.index);
  for (let i = removed.length - 1; i >= 0; i--) memHits.splice(removed[i].index, 1);
  ui.exitMemSelect();
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(
      removed.map((x) => ({ entryId: x.h.entry_id, deleted: true }))
    );
    const results = (res && res.results) || [];
    const okIds = new Set(results.filter((r) => r && r.ok).map((r) => String(r.entry_id)));
    const okRows = removed.filter((x) => okIds.has(String(x.h.entry_id)));
    const failedRows = removed.filter((x) => !okIds.has(String(x.h.entry_id)));
    if (failedRows.length) {
      restoreMemRows(failedRows);
      ui.renderMemory(memHits, memCallbacks());
      updateMemMeta();
    }
    if (!okRows.length) {
      // Everything came back skipped. If the backend rejected the recordings
      // as read-only / unsupported, it's an older deployment — say so and how
      // to fix it, rather than blaming the connection.
      const reason = (results.find((r) => r && r.error) || {}).error || "";
      if (/read-only|unknown action|support delete only|older version/i.test(reason)) {
        warnRecordingDeleteUnsupported();
      } else {
        ui.showUndoToast({
          label: reason ? "Couldn't delete — " + reason : "Couldn't delete — check your connection.",
        });
      }
      return;
    }
    ui.memorySyncedNow();
    ui.showUndoToast({
      label: failedRows.length
        ? okRows.length + " deleted, " + failedRows.length + " skipped"
        : "Deleted " + okRows.length + (okRows.length === 1 ? " item" : " items"),
      duration: 6000,
      onUndo: () => undoBatchDelete(okRows),
    });
  } catch (err) {
    restoreMemRows(removed);
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't delete — check your connection." });
  }
}

// Put deleted rows back where they were (rows arrive sorted by original
// index, so inserting in order rebuilds the exact list).
function restoreMemRows(rows) {
  for (const x of rows) memHits.splice(Math.min(x.index, memHits.length), 0, x.h);
}

async function undoBatchDelete(rows) {
  restoreMemRows(rows);
  ui.renderMemory(memHits, memCallbacks());
  updateMemMeta();
  try {
    const res = await api.batchUpdateMemory(
      rows.map((x) => ({ entryId: x.h.entry_id, deleted: false }))
    );
    const results = (res && res.results) || [];
    const failedIds = new Set(results.filter((r) => r && !r.ok).map((r) => String(r.entry_id)));
    if (failedIds.size) {
      for (const x of rows) {
        if (!failedIds.has(String(x.h.entry_id))) continue;
        const at = memHits.indexOf(x.h);
        if (at >= 0) memHits.splice(at, 1);
      }
      ui.renderMemory(memHits, memCallbacks());
      ui.showUndoToast({
        label: "Couldn't restore " + failedIds.size + (failedIds.size === 1 ? " item" : " items"),
      });
    }
    updateMemMeta();
    ui.memorySyncedNow();
  } catch (err) {
    for (const x of rows) {
      const at = memHits.indexOf(x.h);
      if (at >= 0) memHits.splice(at, 1);
    }
    ui.renderMemory(memHits, memCallbacks());
    updateMemMeta();
    ui.showUndoToast({ label: "Couldn't restore those — check your connection." });
  }
}

/* ------------------------------------------------------------------ *
 * Voice recorder — press record, talk up to 30 minutes; the audio lands
 * in Drive, the transcript in the Sheet, and the distilled notes in
 * memory (each linking back to the audio). While recording, speech.js's
 * recorder mode keeps Sharon silent: recognition keeps running with its
 * restart stitching (so no words drop), but every result flows into the
 * transcript accumulator here instead of the assist pipeline.
 * ------------------------------------------------------------------ */
const RECORD_MAX_MS = 30 * 60 * 1000; // hard cap — auto-stops at exactly 30:00
const REC_TIMER_TICK_MS = 250;
// Compact voice bitrate — speech is fine at 32 kbps, and a full 30-minute
// recording stays well under the backend's play-in-panel size cap.
const RECORD_AUDIO_BPS = 32000;

let recState = "idle"; // the stage WITHIN the RECORDING mode: idle | recording | uploading | organizing
let mediaRecorder = null;
let recChunks = [];
let recStartAt = 0;
let recTimerInt = null;
let recStageTimer = null;
let recFinalText = ""; // confirmed words
let recInterimText = ""; // in-flight words (shown lighter)
let recSegments = []; // [{ t: seconds, text }] — one per finalized segment

// The one test for "the recorder flow is live": the mode manager's word.
// recState is the recorder's internal stage label; the MODE says whether
// the flow (recording → uploading → organizing) is active at all.
function recActive() {
  return inMode(MODES.RECORDING);
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
}

function pickRecorderMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || "");
      resolve(s.slice(s.indexOf(",") + 1)); // strip the data: URL prefix
    };
    r.onerror = () => reject(new Error("I couldn't read the recorded audio."));
    r.readAsDataURL(blob);
  });
}

async function startRecording() {
  if (recActive()) return;
  const mime = pickRecorderMime();
  if (!mime) {
    reportProblem(
      "recording isn't supported in this browser.",
      "Chrome should support it — try updating Chrome, then reload me."
    );
    return;
  }

  // Reuse speech.js's mic stream (one permission, same constraints).
  let stream;
  try {
    stream = await speech.getMicStream();
  } catch (_) {
    reportProblem(
      "I couldn't use the microphone to record.",
      "Click the lock icon by the browser's address bar, allow the microphone, then tap record again."
    );
    return;
  }

  // Build the MediaRecorder BEFORE any mode change, so a failure here
  // leaves Sharon exactly where she was.
  try {
    preparedRec = new MediaRecorder(stream, {
      mimeType: mime,
      audioBitsPerSecond: RECORD_AUDIO_BPS,
    });
  } catch (_) {
    preparedRec = null;
    reportProblem("I couldn't start the recorder.", "Give it a second and tap record again.");
    return;
  }

  // The manager exits whatever came before (SEARCHING aborts its call),
  // then runs enterRecordingMode below.
  enterMode(MODES.RECORDING);
}

// RECORDING's enter routine — runs inside the manager AFTER the previous
// mode's exit. From here until finishRecording hands back to LISTENING,
// the recorder owns the ears (speech.js's seal) and Sharon stays silent.
function enterRecordingMode() {
  const recorder = preparedRec;
  preparedRec = null;
  if (!recorder) throw new Error("record entered with nothing prepared");

  // Playback is sound in the room — it must never land in the recording.
  // Pause it cleanly (no auto-resume; the user can tap play afterwards).
  pausePlaybackForUser();
  // "Record mid-anything": abandon the in-flight assist cleanly — its
  // finally block tidies the UI.
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  resetCapture(); // drop any half-captured utterance cleanly

  recFinalText = "";
  recInterimText = "";
  recSegments = [];
  recStartAt = Date.now(); // set before recorder mode so segment stamps are right
  speech.setRecorderState("recording", {
    onFinal: (text) => {
      // Stamp each finalized segment with its elapsed recording time so
      // search can later queue playback to the matching moment.
      recSegments.push({
        t: Math.max(0, Math.round((Date.now() - recStartAt) / 1000)),
        text,
      });
      recFinalText = recFinalText ? recFinalText + " " + text : text;
      recInterimText = "";
      ui.recTranscript(recFinalText, "");
    },
    onInterim: (text) => {
      recInterimText = text;
      ui.recTranscript(recFinalText, text);
    },
  });

  recChunks = [];
  mediaRecorder = recorder;
  mediaRecorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size) recChunks.push(ev.data);
  });
  recState = "recording"; // set before start() so a throw is cleaned up fully
  mediaRecorder.start(1000); // 1s chunks — a crash loses at most a second

  ui.recTranscript("", "");
  ui.setRecorderStage("recording");
  ui.setRecTimer("00:00 / " + fmtClock(RECORD_MAX_MS));
  ui.showRecorder();
  recTimerInt = setInterval(() => {
    const elapsed = Date.now() - recStartAt;
    ui.setRecTimer(fmtClock(Math.min(elapsed, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
    if (elapsed >= RECORD_MAX_MS) stopRecording(); // auto-stop at 30:00
  }, REC_TIMER_TICK_MS);
  updateStatus();
}

// RECORDING's exit routine — idempotent. The normal path (finishRecording)
// has already wound everything down, so this is a no-op there; on any other
// path out it force-stops the hardware, timers, and the speech.js seal so
// a failed transition can never leave a half-live recorder behind.
function forceRecorderIdle() {
  if (recTimerInt) {
    clearInterval(recTimerInt);
    recTimerInt = null;
  }
  if (recStageTimer) {
    clearTimeout(recStageTimer);
    recStageTimer = null;
  }
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch (_) {
      /* ignore */
    }
    mediaRecorder = null;
    recChunks = [];
  }
  if (recState !== "idle") {
    recState = "idle";
    ui.hideRecorder();
  }
  speech.setRecorderState("idle"); // no-op when the seal is already open
}

function stopRecording() {
  if (recState !== "recording") return;
  recState = "uploading";
  if (recTimerInt) {
    clearInterval(recTimerInt);
    recTimerInt = null;
  }
  const durationSeconds = Math.min(
    Math.round((Date.now() - recStartAt) / 1000),
    Math.round(RECORD_MAX_MS / 1000)
  );

  // Fold any in-flight interim into the transcript (and its own timestamped
  // segment) FIRST — then hand the seal to speech.js, which aborts the
  // engine (discarding everything it still owes for the recorded audio) and
  // keeps discarding results until the whole flow is idle again. Nothing
  // said during the recording can resurface in the assist flow afterward.
  if (recInterimText.trim()) {
    recSegments.push({
      t: Math.max(0, Math.round((Date.now() - recStartAt) / 1000)),
      text: recInterimText.trim(),
    });
    recFinalText = (recFinalText + " " + recInterimText).trim();
    recInterimText = "";
  }
  speech.setRecorderState("uploading");

  const transcript = recFinalText.trim();
  const segments = recSegments.slice();
  recSegments = [];
  ui.recTranscript(transcript, "");
  ui.setRecorderStage("uploading");
  updateStatus();

  const rec = mediaRecorder;
  mediaRecorder = null;
  const finish = () =>
    finishRecording((rec && rec.mimeType) || "audio/webm", durationSeconds, transcript, segments);
  if (rec && rec.state !== "inactive") {
    rec.addEventListener("stop", finish, { once: true });
    try {
      rec.stop();
    } catch (_) {
      finish();
    }
  } else {
    finish();
  }
}

async function finishRecording(mimeType, durationSeconds, transcript, segments) {
  const blob = new Blob(recChunks, { type: mimeType || "audio/webm" });
  recChunks = [];
  if (!blob.size) {
    recState = "idle";
    speech.setRecorderState("idle");
    ui.hideRecorder();
    enterMode(MODES.LISTENING); // the flow is over — hand the mode back
    reportProblem(
      "the recording came out empty, so there was nothing to save.",
      "Tap record and try again."
    );
    updateStatus();
    return;
  }

  // One round trip does everything server-side (Drive, Sheet, notes). We
  // can't observe upload progress, so flip the label to "organizing" once
  // the upload has plausibly finished — a size-based estimate.
  const estUploadMs = Math.min(45000, Math.max(2500, blob.size / 150));
  recStageTimer = setTimeout(() => {
    recState = "organizing";
    speech.setRecorderState("organizing");
    ui.setRecorderStage("organizing");
  }, estUploadMs);

  try {
    const audioBase64 = await blobToBase64(blob);
    const id = await ensureSessionId();
    const result = await api.saveRecording({
      sessionId: id,
      audioBase64,
      mimeType: blob.type || "audio/webm",
      durationSeconds,
      transcript,
      segments: Array.isArray(segments) ? segments : [],
      timestamp: new Date().toISOString(),
    });
    ui.hideRecorder();
    const minutes = Math.max(1, Math.round(durationSeconds / 60));
    ui.addRecordingCard({
      driveUrl: result.drive_file_url,
      recordingId: result.recording_id,
      durationLabel: minutes + " min",
      notes: Array.isArray(result.notes) ? result.notes : [],
      onListen: ({ recordingId, driveUrl }) =>
        playRecording({
          recordingId,
          driveUrl,
          startSeconds: 0,
          label: "Recording — just now (" + minutes + " min)",
        }),
    });
    // The recording card is Sharon's side of this turn — put it in history
    // too, so a follow-up like "yes I do" binds to the recording that was
    // just saved instead of leaving the model to guess.
    const noteCount = Array.isArray(result.notes) ? result.notes.length : 0;
    remember(
      "assistant",
      "I saved your " + minutes + "-minute voice recording" +
        (noteCount
          ? " and distilled " + noteCount + (noteCount === 1 ? " note" : " notes") + " from it"
          : "") +
        ". The audio is linked on its card if you want to listen back to it."
    );
    refreshMemoryCount();
  } catch (err) {
    ui.hideRecorder();
    reportProblem(
      "I couldn't save that recording — " + ((err && err.message) || "the upload failed."),
      nextStepFor(err)
    );
  } finally {
    if (recStageTimer) {
      clearTimeout(recStageTimer);
      recStageTimer = null;
    }
    recState = "idle";
    speech.setRecorderState("idle"); // the seal lifts after its grace period
    enterMode(MODES.LISTENING); // upload + organizing done — RECORDING ends here
    updateStatus();
  }
}

/* ------------------------------------------------------------------ *
 * The mode lifecycle — the remaining enter/exit routines the manager
 * (mode.js) runs. RECORDING's live above with the recorder it drives.
 * ------------------------------------------------------------------ */
// LISTENING is the safe landing: every mode returns here, including any
// failed transition the manager rescues. Everything here is idempotent —
// on a normal transition the leaving mode's exit already did this work.
function enterListeningMode() {
  forceRecorderIdle();
  updateStatus();
}

// SEARCHING's exit routine: leaving the mode for ANY reason other than the
// reply itself (barge-in, a record tap, a new message) cancels the
// in-flight call. Normal completion nulls searchAc first (sendTurn's
// finally), so a finished call is never aborted.
function exitSearchingMode() {
  const pending = searchAc;
  searchAc = null;
  if (pending) {
    try {
      pending.abort();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ *
 * In-panel audio player — plays a saved recording right here, queued to
 * the moment that matched the user's question. The audio arrives base64
 * through the backend (the Drive file stays private; no sharing changes),
 * becomes a Blob URL, and drives one <audio> element. One player at a
 * time: starting another recording replaces (and revokes) the last one.
 * Coordination with the ears/voice:
 *   • while playing, speech.js's playback mode (rule 7) keeps the sound
 *     from becoming commands — confident user speech pauses it instead;
 *   • Sharon speaking pauses playback and it resumes when she's done;
 *   • starting a recording pauses playback for good (no auto-resume);
 *   • any failure or a too_large file falls back to the Drive link.
 * ------------------------------------------------------------------ */
let plAudio = null; // the one <audio>
let plBlobUrl = null; // revoked whenever replaced
let plRecordingId = null; // what's loaded
let plLoadingId = null; // what's being fetched
let plDriveUrl = ""; // the always-available fallback
let plDuration = 0; // seconds (sheet value until the element knows better)
let plPausedForSpeech = false; // paused by Sharon's own voice → auto-resume
let plLoadSeq = 0; // stale-fetch guard

function playerPlaying() {
  return !!(plAudio && !plAudio.paused && !plAudio.ended);
}

// A deliberate pause (user barge-in, recorder start): never auto-resumes.
function pausePlaybackForUser() {
  if (!plAudio) return;
  plPausedForSpeech = false;
  try {
    plAudio.pause();
  } catch (_) {
    /* ignore */
  }
}

// Sharon's voice and the player never talk at once: her reply (or a live
// recording) pauses playback; a speech-pause resumes once the panel is
// genuinely idle again — not while the user is mid-sentence or a turn is
// in flight.
function syncPlaybackWithSpeech() {
  if (!plAudio) return;
  if (speech.isSpeaking() || recActive()) {
    if (playerPlaying()) {
      if (speech.isSpeaking()) plPausedForSpeech = true; // resume after her reply
      try {
        plAudio.pause();
      } catch (_) {
        /* ignore */
      }
    }
    return;
  }
  if (plPausedForSpeech && !thinking && !busy && !hearing && !pendingText) {
    plPausedForSpeech = false;
    plAudio.play().catch(() => {});
  }
}

function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/webm" });
}

// Release the current audio + Blob URL (the "one player at a time" rule).
function stopPlayback() {
  const a = plAudio;
  plAudio = null;
  plRecordingId = null;
  plPausedForSpeech = false;
  plDuration = 0;
  if (a) {
    try {
      a.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      a.removeAttribute("src");
      a.load();
    } catch (_) {
      /* ignore */
    }
  }
  if (plBlobUrl) {
    try {
      URL.revokeObjectURL(plBlobUrl);
    } catch (_) {
      /* ignore */
    }
    plBlobUrl = null;
  }
  speech.setPlaybackActive(false);
  ui.playerSetPlaying(false);
}

function closePlayer() {
  plLoadSeq++; // discard any fetch still in flight
  plLoadingId = null;
  stopPlayback();
  ui.playerHide();
}

// Never a dead click: any failure (or a too_large file) becomes the exact
// old behavior — the recording opens in Drive — plus a plain message.
function playbackFallback(url, msg) {
  stopPlayback();
  ui.playerHide();
  ui.addSharonBubble(
    msg +
      (url ? "" : " I couldn't find its Drive link either — it's in your “Sharon Recordings” folder.")
  );
  if (url) {
    try {
      window.open(url, "_blank", "noopener");
    } catch (_) {
      /* the message above still tells them where it lives */
    }
  }
}

// A recording hit (search card or memory row) → play at its matched moment.
// Old recordings without segments simply have no start_seconds → 0:00.
function playRecordingFromHit(h) {
  const recordingId =
    String(h.recording_id || "").trim() || String(h.entry_id || "").replace(/^rec:/, "").trim();
  playRecording({
    recordingId,
    driveUrl: h.page_url || "",
    startSeconds: Math.max(0, Math.round(Number(h.start_seconds) || 0)),
    label: h.title || "Recording",
  });
}

async function playRecording({ recordingId, driveUrl, startSeconds = 0, label = "Recording" }) {
  recordingId = String(recordingId || "").trim();
  if (!recordingId) {
    playbackFallback(
      driveUrl,
      "I couldn't work out which recording that was, so I've opened it in your Drive instead."
    );
    return;
  }

  // Same recording already loaded — just jump to the moment and play.
  if (plAudio && plRecordingId === recordingId) {
    if (speech.isSpeaking()) speech.stopSpeaking();
    plPausedForSpeech = false;
    const at = plDuration
      ? Math.min(Math.max(0, startSeconds), Math.max(0, plDuration - 1))
      : Math.max(0, startSeconds);
    try {
      plAudio.currentTime = at;
    } catch (_) {
      /* ignore */
    }
    ui.playerSetTime(at, plDuration);
    plAudio.play().catch(() => {});
    return;
  }
  if (plLoadingId && plLoadingId === recordingId) return; // already fetching it

  const seq = ++plLoadSeq;
  stopPlayback();
  plLoadingId = recordingId;
  plDriveUrl = driveUrl || "";
  ui.playerShow({ label, driveUrl: plDriveUrl });

  let result;
  try {
    // No abort timeout on purpose — a long file legitimately takes a while;
    // the bar shows a loading state the whole time.
    result = await api.getRecordingAudio(recordingId);
  } catch (err) {
    if (seq !== plLoadSeq) return;
    plLoadingId = null;
    playbackFallback(
      plDriveUrl,
      "I couldn't fetch that recording's audio just now, so I've opened it in your Drive instead."
    );
    return;
  }
  if (seq !== plLoadSeq) return; // replaced or closed while fetching
  plLoadingId = null;

  if (result && result.too_large) {
    playbackFallback(
      result.drive_file_url || plDriveUrl,
      "That recording's file is too big for me to play here, so I've opened it in your Drive instead."
    );
    return;
  }
  if (!result || !result.audio_base64) {
    playbackFallback(
      plDriveUrl,
      "I couldn't load that recording's audio, so I've opened it in your Drive instead."
    );
    return;
  }

  let blob;
  try {
    blob = base64ToBlob(result.audio_base64, result.mime_type);
  } catch (_) {
    playbackFallback(
      result.drive_file_url || plDriveUrl,
      "That recording's audio wouldn't decode here, so I've opened it in your Drive instead."
    );
    return;
  }

  plRecordingId = recordingId;
  plDriveUrl = result.drive_file_url || plDriveUrl;
  plDuration = Math.max(0, Number(result.duration_seconds) || 0);
  plBlobUrl = URL.createObjectURL(blob);
  const audio = new Audio();
  plAudio = audio;
  const start = Math.max(0, Math.round(Number(startSeconds) || 0));

  const beginAt = () => {
    if (plAudio !== audio) return;
    if (isFinite(audio.duration) && audio.duration > 0) plDuration = audio.duration;
    ui.playerReady(plDuration);
    const at = plDuration ? Math.min(start, Math.max(0, plDuration - 1)) : start;
    try {
      audio.currentTime = at;
    } catch (_) {
      /* plays from wherever it can */
    }
    ui.playerSetTime(at, plDuration);
    if (speech.isSpeaking()) speech.stopSpeaking(); // never both at once
    plPausedForSpeech = false;
    audio.play().catch(() => {
      // Autoplay refused (shouldn't happen after a click) — the bar is
      // ready; the user just taps play.
    });
  };

  audio.addEventListener("loadedmetadata", () => {
    if (plAudio !== audio) return;
    if (isFinite(audio.duration) && audio.duration > 0) {
      beginAt();
      return;
    }
    // MediaRecorder webm quirk: the blob reports Infinity until the engine
    // is pushed past the end once; then the real duration appears and
    // seeking works. The sheet's duration_seconds covers the display.
    const onDur = () => {
      if (plAudio !== audio) return;
      if (!isFinite(audio.duration) || audio.duration <= 0) return;
      audio.removeEventListener("durationchange", onDur);
      beginAt();
    };
    audio.addEventListener("durationchange", onDur);
    try {
      audio.currentTime = 1e7;
    } catch (_) {
      beginAt();
    }
  });
  audio.addEventListener("error", () => {
    if (plAudio !== audio) return;
    playbackFallback(
      plDriveUrl,
      "I couldn't play that recording here, so I've opened it in your Drive instead."
    );
  });
  audio.addEventListener("play", () => {
    if (plAudio !== audio) return;
    speech.setPlaybackActive(true); // rule 7: the room is not quiet now
    ui.playerSetPlaying(true);
  });
  audio.addEventListener("pause", () => {
    if (plAudio !== audio) return;
    speech.setPlaybackActive(false);
    ui.playerSetPlaying(false);
  });
  audio.addEventListener("ended", () => {
    if (plAudio !== audio) return;
    plPausedForSpeech = false;
    speech.setPlaybackActive(false);
    ui.playerSetPlaying(false);
  });
  audio.addEventListener("timeupdate", () => {
    if (plAudio !== audio) return;
    ui.playerSetTime(audio.currentTime, plDuration);
  });
  audio.src = plBlobUrl;
}

/* ------------------------------------------------------------------ *
 * Wiring: mic, composer, live card, header, memory, settings, welcome
 * ------------------------------------------------------------------ */
function toggleMic() {
  if (modeActionBusy) return; // a mode transition is settling — let it finish
  if (recActive()) {
    // The recorder owns the ears — muting would cut the transcript.
    hint("I'm recording right now — tap the round button to stop.");
    return;
  }
  if (!speech.speechRecognitionAvailable()) {
    reportProblem(
      "Voice input isn't available in this browser.",
      "Type to me in the box below instead — everything works the same way, and I'll still read answers aloud."
    );
    return;
  }
  if (speech.isMicBlocked()) {
    speech.retryMic();
    updateStatus();
    return;
  }
  // While Sharon is reading, a tap is a natural "stop" (barge-in).
  if (speech.isSpeaking()) {
    speech.stopSpeaking();
    updateStatus();
    return;
  }
  speech.setMicMuted(!speech.isMicMuted());
  updateStatus();
}

function sendTyped(text) {
  const e = ui.els;
  const t = (text != null ? text : e.composerInput ? e.composerInput.value : "").trim();
  if (!t) return;
  if (text == null && e.composerInput) e.composerInput.value = "";
  ui.setComposerHasText(false);
  // Typed messages must land in a visible thread too — leave Notes first
  // (a no-op when it isn't open; handleUserUtterance guards this as well).
  notes.closeNotesView();
  handleUserUtterance(t, null, { typed: true });
}

// The welcome "Connect" step and the Settings "Connect" pill both just try
// the Sheet for real and report honestly.
async function tryConnectMemory(onStatus) {
  onStatus && onStatus("Linking “Speaking Assistant”…");
  try {
    await api.searchMemory({ query: "", limit: 1, touch: false });
    markSetup("memory");
    onStatus && onStatus("“Speaking Assistant” Sheet · connected");
  } catch (err) {
    onStatus &&
      onStatus(
        "Couldn't reach your Sheet — check your connection and try again. If your passphrase was rejected, the unlock screen comes back on its own."
      );
  }
}

function applySettingsToUI() {
  const e = ui.els;
  if (e.autoReadToggle) e.autoReadToggle.checked = !!settings.autoRead;
  if (e.scrollToggle) e.scrollToggle.checked = !!settings.allowScroll;
  if (e.actionsToggle) e.actionsToggle.checked = !!settings.allowActions;
  if (e.confirmToggle) e.confirmToggle.checked = !!settings.confirmActions;
  populateVoiceSelect();
  if (e.voiceSelect) e.voiceSelect.value = settings.voiceName || "";
  if (e.voiceSpeed)
    e.voiceSpeed.value = settings.voiceRate <= 0.92 ? "slow" : settings.voiceRate >= 1.0 ? "brisk" : "normal";
  ui.setVoiceIndicator(!!settings.readAloud);
}

function populateVoiceSelect() {
  const sel = ui.els.voiceSelect;
  if (!sel) return;
  const current = settings.voiceName || "";
  const sorted = speech.englishVoicesSorted();
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (best available)";
  sel.appendChild(auto);
  let hasCurrent = !current;
  for (const v of sorted) {
    const o = document.createElement("option");
    o.value = v.name;
    o.textContent = speech.friendlyVoiceName(v);
    if (v.name === current) hasCurrent = true;
    sel.appendChild(o);
  }
  if (current && !hasCurrent) {
    const o = document.createElement("option");
    o.value = current;
    o.textContent = current + " (unavailable)";
    sel.appendChild(o);
  }
  sel.value = current;
}

function wireControls() {
  const e = ui.els;

  // Composer: pill input + blue send circle (only with text).
  if (e.sendBtn) e.sendBtn.addEventListener("click", () => sendTyped());
  if (e.composerInput) {
    e.composerInput.addEventListener("input", () => {
      ui.setComposerHasText(!!e.composerInput.value.trim());
    });
    e.composerInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        sendTyped();
      }
    });
  }

  // Mode bar — the two tappable icons. Mic toggles mute (mute stays
  // independent of the mode); record starts/stops the voice-memo recorder.
  if (e.micBtn) e.micBtn.addEventListener("click", toggleMic);
  if (e.recordBtn)
    e.recordBtn.addEventListener("click", () =>
      runModeAction(async () => {
        if (recState === "recording") {
          stopRecording();
        } else if (recActive()) {
          // The mode is RECORDING but the mic has stopped — we're mid
          // upload/organize. Starting again now would race the save.
          hint("Still saving your last recording — one moment.");
        } else {
          await startRecording();
        }
      })
    );
  if (e.recStop) e.recStop.addEventListener("click", () => runModeAction(async () => stopRecording()));
  // Closing the tab ends the voice recording (its state is in-memory only).
  window.addEventListener("pagehide", () => {
    if (recState === "recording" && mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
  });

  // In-panel player: play/pause, seek, close. (The Drive link is a plain <a>.)
  if (e.plToggle)
    e.plToggle.addEventListener("click", () => {
      if (!plAudio) return;
      if (playerPlaying()) {
        pausePlaybackForUser();
      } else {
        if (speech.isSpeaking()) speech.stopSpeaking(); // never both at once
        plPausedForSpeech = false;
        plAudio.play().catch(() => {});
      }
    });
  if (e.plSeek)
    e.plSeek.addEventListener("input", () => {
      if (!plAudio) return;
      const v = Math.max(0, Number(e.plSeek.value) || 0);
      try {
        plAudio.currentTime = v;
      } catch (_) {
        /* ignore */
      }
      ui.playerSetTime(v, plDuration);
    });
  if (e.plClose) e.plClose.addEventListener("click", closePlayer);

  // Live-presence card: mute pill, tap-to-edit strip, editor buttons.
  if (e.lcMute) e.lcMute.addEventListener("click", toggleMic);
  if (e.lcStrip) e.lcStrip.addEventListener("click", openEditor);
  if (e.lcSend)
    e.lcSend.addEventListener("click", () => {
      if (recActive()) {
        resetCapture(); // voice drafts never survive into a recording
        return;
      }
      const text = ui.liveEditorValue().trim();
      const conf = pendingConf;
      resetCapture();
      if (!text) return;
      ui.addUserTurn(text, { spoken: true });
      sendTurn(text, { raw: text, conf });
    });
  if (e.lcDiscard) e.lcDiscard.addEventListener("click", () => resetCapture());
  if (e.lcEditArea)
    e.lcEditArea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        e.lcSend.click();
      }
    });

  // Header: status line stops TTS while speaking; voice / memory / settings.
  if (e.statusLine)
    e.statusLine.addEventListener("click", () => {
      if (speech.isSpeaking()) {
        speech.stopSpeaking();
        updateStatus();
      }
    });
  if (e.voiceBtn)
    e.voiceBtn.addEventListener("click", () => {
      settings.readAloud = !settings.readAloud;
      saveSettings();
      if (!settings.readAloud) speech.stopSpeaking();
      ui.setVoiceIndicator(settings.readAloud);
      updateStatus();
    });
  const openMemoryView = () => {
    // Always open on the full memory list, never a stale Recordings filter.
    memShowingRecordings = false;
    ui.selectFilter("all");
    ui.openMemory();
    loadMemory(e.memSearchInput ? e.memSearchInput.value.trim() : "");
  };
  if (e.memoryBtn) e.memoryBtn.addEventListener("click", openMemoryView);
  // Bottom-bar toggle: flip between the conversation and the memory view from
  // a fixed spot, so you can bounce back and forth without hunting the header.
  if (e.memNavBtn)
    e.memNavBtn.addEventListener("click", () => {
      if (ui.memoryOpen()) ui.closeMemory();
      else openMemoryView();
    });
  if (e.memBack) e.memBack.addEventListener("click", ui.closeMemory);
  if (e.settingsBtn)
    e.settingsBtn.addEventListener("click", () => {
      applySettingsToUI();
      refreshSetupRows();
      ui.openSettings();
    });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", ui.closeSettings));
  if (e.scrim) e.scrim.addEventListener("click", ui.closeSettings);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (ui.settingsOpen()) ui.closeSettings();
    else if (ui.memoryOpen()) {
      // Escape backs out one layer at a time: selection first, then the view.
      if (ui.memSelectActive()) ui.exitMemSelect();
      else ui.closeMemory();
    }
  });

  // Memory search (debounced, live filtering via the backend).
  let memSearchTimer = null;
  if (e.memSearchInput)
    e.memSearchInput.addEventListener("input", () => {
      const q = e.memSearchInput.value.trim();
      // Searching always works against the full memory list (a keyword search
      // also surfaces recording transcripts), so drop the Recordings filter.
      if (memShowingRecordings) {
        memShowingRecordings = false;
        ui.selectFilter("all");
      }
      if (memSearchTimer) clearTimeout(memSearchTimer);
      memSearchTimer = setTimeout(() => loadMemory(q), 320);
    });

  // Preferences. (The page-related toggles still save their choice so the
  // stored settings shape stays intact, but nothing on a web page reads
  // them — see DEFAULT_SETTINGS.)
  if (e.autoReadToggle)
    e.autoReadToggle.addEventListener("change", () => {
      settings.autoRead = e.autoReadToggle.checked;
      saveSettings();
      updateStatus();
    });
  if (e.scrollToggle)
    e.scrollToggle.addEventListener("change", () => {
      settings.allowScroll = e.scrollToggle.checked;
      saveSettings();
    });
  if (e.actionsToggle)
    e.actionsToggle.addEventListener("change", () => {
      settings.allowActions = e.actionsToggle.checked;
      saveSettings();
      updateStatus();
    });
  if (e.confirmToggle)
    e.confirmToggle.addEventListener("change", () => {
      settings.confirmActions = e.confirmToggle.checked;
      saveSettings();
    });
  if (e.voiceSelect)
    e.voiceSelect.addEventListener("change", () => {
      settings.voiceName = e.voiceSelect.value || "";
      saveSettings();
    });
  if (e.voiceSpeed)
    e.voiceSpeed.addEventListener("change", () => {
      settings.voiceRate = { slow: 0.9, normal: 0.95, brisk: 1.05 }[e.voiceSpeed.value] || 0.95;
      saveSettings();
    });
  if (e.voicePreview) e.voicePreview.addEventListener("click", () => speech.previewVoice());

  // Setup rows in Settings + the welcome steps share the same real actions.
  if (e.suMicBtn)
    e.suMicBtn.addEventListener("click", () => {
      speech.retryMic();
      updateStatus();
    });
  if (e.suMemoryBtn)
    e.suMemoryBtn.addEventListener("click", () =>
      tryConnectMemory((s) => ui.setSetupRow("memory", setup.memory, s))
    );
  if (e.suHelloBtn)
    e.suHelloBtn.addEventListener("click", () => {
      ui.closeSettings();
      sendTyped("Hello!");
    });
  if (e.replaySetup)
    e.replaySetup.addEventListener("click", () => {
      ui.closeSettings();
      refreshWelcomeSteps();
      ui.showWelcome();
    });

  // Welcome steps.
  if (e.wAllowBtn)
    e.wAllowBtn.addEventListener("click", () => {
      ui.setWelcomeStep("mic", "doing", "Waiting for the browser's permission prompt — choose Allow.");
      speech.retryMic();
      updateStatus();
    });
  if (e.wConnectBtn)
    e.wConnectBtn.addEventListener("click", () => {
      ui.setWelcomeStep("memory", "doing", "Linking “Speaking Assistant”…");
      tryConnectMemory((s) => {
        if (!setup.memory) ui.setWelcomeStep("memory", "active", s);
      });
    });
  if (e.wHelloBtn)
    e.wHelloBtn.addEventListener("click", () => {
      ui.hideWelcome();
      sendTyped("Hello!");
    });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function init() {
  // The gate first: nothing below talks to the backend until the visitor's
  // passphrase is in localStorage (returns immediately when it already is).
  await ensureApiKey();

  await ensureSessionId();
  await loadSettings();
  await loadSetup();

  ui.initUI();
  ui.setMemFilterHandler(onMemFilterChange);

  // The Notes view wires its own controls; it only needs the redeploy
  // walkthrough for a stale backend, and a guard so dictation can never
  // start while a voice recording owns the ears.
  notes.initNotes({
    redeploySteps: REDEPLOY_STEPS,
    canDictate: () => !recActive(),
  });

  // The mode manager — Sharon is in exactly one mode; every feature routes
  // its entries and exits through here. Opens in LISTENING (the default),
  // so a reloaded page never resumes a stuck mode: recorder state is
  // in-memory only, and this registration starts it clean.
  initModes({
    routines: {
      [MODES.LISTENING]: { enter: enterListeningMode },
      [MODES.RECORDING]: { enter: enterRecordingMode, exit: forceRecorderIdle },
      [MODES.SEARCHING]: { enter: updateStatus, exit: exitSearchingMode },
    },
    onChange: (m) => {
      ui.setMode(m);
      updateStatus();
    },
  });

  speech.initSpeech({
    getSettings: () => settings,
    onFinal: (text, conf) => {
      markSetup("mic");
      hearing = false;
      if (hearingTimer) {
        clearTimeout(hearingTimer);
        hearingTimer = null;
      }
      handleUserUtterance(text, conf);
    },
    onInterim: onInterimHeard,
    onStateChange: () => updateStatus(),
    onMicBlocked: () => {
      if (ui.welcomeVisible()) {
        ui.setWelcomeStep(
          "mic",
          "active",
          "I couldn't use the microphone. Click the lock icon by the browser's address bar, allow the microphone, then tap Allow again."
        );
      } else {
        reportProblem(
          "I couldn't access the microphone.",
          "Click the lock icon by the browser's address bar, allow the microphone, then tap the mic button to try again. You can type to me in the meantime."
        );
      }
      updateStatus();
    },
    onRecognitionTrouble: () => {
      reportProblem(
        "my hearing keeps cutting out.",
        "Voice recognition needs the internet — check your connection. I'll keep retrying quietly, and you can type to me in the meantime."
      );
    },
    onVoicesChanged: () => populateVoiceSelect(),
    // The user spoke over a playing recording — pause it, exactly like
    // barging in on Sharon. Their words are dropped by speech.js (they may
    // BE the playback), so they can speak again into clean silence.
    onPlaybackBargeIn: () => {
      pausePlaybackForUser();
      updateStatus();
    },
  });

  wireControls();
  applySettingsToUI();
  refreshSetupRows();

  // First run only: the welcome walkthrough. After that, setup lives in
  // Settings as three quiet status rows and never blocks the panel again.
  if (!setupComplete()) {
    refreshWelcomeSteps();
    ui.showWelcome();
  }

  // Notes is the panel's home view — open it unless the welcome walkthrough
  // is on screen (first run always wins). The moment the user actually
  // addresses Sharon, handleUserUtterance/sendTyped close Notes back to the
  // conversation, so her replies are never hidden behind it.
  if (!ui.welcomeVisible()) notes.openNotesView();

  updateStatus();
  // Listening from launch — the mic starts live the moment the page opens.
  speech.startRecognition();
  watchMicPermission();

  refreshMemoryCount();

  // Restore the conversation thread from the Sheet so a reloaded page
  // remembers what you were talking about (best-effort, non-blocking).
  try {
    const turns = await api.getRecentTurns(sessionId, HISTORY_TURNS);
    markSetup("memory");
    if (Array.isArray(turns) && !history.length) {
      for (const t of turns) {
        if (t && (t.role === "user" || t.role === "assistant")) remember(t.role, t.content);
      }
    }
  } catch (_) {
    /* fine — she just starts fresh; setup shows what to check */
  }
})();
