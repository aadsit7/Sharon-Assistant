// sidepanel.js — Sharon's orchestrator. Wires the ears/voice (speech.js), the
// backend brain (api.js), and the UI (ui.js) into one conversation loop:
//
//   listen → live transcript streams into the presence card → (instant
//   command? do it locally) → adaptive silence countdown (tap to edit) →
//   assist() one round trip: Claude answers AND/OR reads-writes the Google
//   Sheet database through tools → answer cards in the thread (+ spoken-aloud
//   line) → undo toast → listen.
//
// What makes this fast and conversational:
//   • Real multi-turn memory: the last HISTORY_TURNS exchanges ride along
//     with every request (and are restored from the Sheet when reopened).
//   • One HTTP round trip per turn — saving notes, searching, summarizing,
//     and answering all happen inside a single assist() call.
//   • Sharon never interrupts you — your words accumulate until a genuine,
//     adaptive silence — and you can interrupt HER: confident speech cancels
//     her reply instantly, while speech.js's six echo-protection layers keep
//     her from ever reacting to her own voice.
//
// THE WEB BUILD: this is the extension's orchestrator running on a normal web
// page, so everything that needed Chrome extension APIs is either replaced or
// gone. Storage is localStorage (storage.js). Downloads are a hidden
// <a download>. Screen recording runs HERE (getDisplayMedia + MediaRecorder in
// this page) instead of a background offscreen document, so it lasts exactly
// as long as this tab stays open. And every read of the user's OTHER tabs —
// the page excerpt, scrolling, the click/type action engine, auto-read, the
// page-awareness pill — is removed rather than faked: assist() always sends an
// empty page object, and an action plan that comes back is ignored.

import { HISTORY_TURNS } from "./config.js";
import * as api from "./api.js";
import * as speech from "./speech.js";
import * as storage from "./storage.js";
import * as ui from "./ui.js";
import * as notes from "./notes.js";
import * as tabs from "./tabs.js";
import * as videostore from "./videostore.js";
import { MODES, initModes, enterMode, inMode } from "./mode.js";

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */
// The page settings the extension had — autoRead, allowScroll, allowActions,
// confirmActions — are gone with the tab reading they controlled. The key
// itself is unchanged, so an existing sharon_settings object still loads; the
// dropped fields are simply ignored.
const SETTINGS_KEY = "sharon_settings";
const DEFAULT_SETTINGS = {
  readAloud: true, // speak answers out loud?
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
let ready = false;
let abortController = null;

// The mode-bar buttons (mic / record / screen) can kick off async work
// (opening the mic stream, reading the page) BEFORE the mode actually
// changes. Without a lock, a second tap — the same button again, or a
// different one — slips through that async gap and overlaps the first,
// which is exactly what made switching between them feel flaky. Every
// mode-button action runs through runModeAction(), so only one is ever in
// flight and taps never interleave.
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
 *
 * The extension also had SCREEN (one look at the current tab) and DICTATING
 * (a page text field borrowing the mic). Both needed the browser's other
 * tabs, so neither mode is ever entered here — Sharon is only ever
 * LISTENING, RECORDING, SCREEN_REC or SEARCHING.
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

// The voice assistant is OPT-IN, every session: the panel opens with the mic
// MUTED, and listening starts only from an explicit user action — the mic
// button (or the live card's Unmute), the "Allow" buttons in the welcome and
// Settings, or the "Activate Sharon" keyboard shortcut. NOTHING turns the
// mic on automatically: not booting, not switching views. Dictation and the
// voice recorder still borrow the engine on their own tap and restore the
// mute afterward — speech.js owns that contract.
//
// Turning the voice assistant on IS switching to it: bring the conversation
// on screen (closing Notes/memory through their normal auto-save paths) so
// the live-presence card and her replies are actually visible.
function showConversationForVoice() {
  notes.closeNotesView(); // auto-saves an open, edited note on the way out
  tabs.goTo("chat"); // navigation only — no mode is touched here
}

function updateStatus() {
  const micLive = !speech.isMicMuted() && !speech.isMicBlocked();
  ui.setMicIndicator(micLive);
  ui.setVoiceIndicator(!!settings.readAloud);

  // The header follows the mode manager first — the status text and the
  // mode bar must never disagree about what Sharon is doing.
  if (recActive()) ui.setPhase("recording");
  else if (screenRecActive())
    ui.setPhase(
      screenRecPhase === "trimming"
        ? "screen_trim"
        : screenRecPhase === "reviewing"
        ? "screen_review"
        : "screen_rec"
    );
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

// The redeploy walkthrough for a stale Apps Script deployment. Pasting new
// code into the editor is not enough — /exec serves the version pinned to
// the deployment, so backend/Code.gs changes only go live via "New version".
const REDEPLOY_STEPS =
  "Your PROXY_URL and API_KEY are fine — the deployment itself is just out of date. " +
  "Open your “Speaking Assistant” Sheet → Extensions → Apps Script, replace the project's code " +
  "with the latest backend/Code.gs from your Sharon download, then choose Deploy → Manage deployments → " +
  "edit (✏️) → Version: “New version” → Deploy. The web-app URL stays the same, so nothing else changes.";

function nextStepFor(err) {
  if (err && err.backendOutdated) return REDEPLOY_STEPS;
  return (
    "Check your internet connection and try again. If it keeps happening, make sure PROXY_URL " +
    "and API_KEY in config.js still match your Apps Script deployment."
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
// The extension's scroll commands ("scroll down", "go to the top", "read
// more") drove the user's other tab through page.js. Nothing here can move
// another tab, so they are gone: those phrases now go to the brain like any
// other sentence instead of being intercepted and pretended at.
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
    // Only meaningful while she's actually paused mid-reply; otherwise it's a
    // real thing to say to her, so let it go to the brain.
    if (speech.isPaused()) {
      speech.resumeSpeaking();
      return true;
    }
    return false;
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
  // never become a message. Screen recording drops spoken input the same way,
  // so Sharon stays quiet and never captures her own reply into the video.
  // speech.js already swallows recognition results; this guards every other
  // way in. Typed composer messages still work — they're deliberate keyboard
  // input, not leaked audio.
  if (!typed && (recActive() || screenRecActive() || !speech.recorderSealOpen())) {
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
async function sendTurn(userText, { raw = "", conf = null } = {}) {
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

  // The mode manager settles this turn's mode up front. Search-intent phrasing
  // lights SEARCHING until the reply arrives. A typed message during RECORDING
  // never touches the mode: the recorder keeps the ears until its whole flow
  // is done.
  const searchIntent = isSearchIntent(userText);
  // A turn never changes the mode while a recorder owns it: the voice recorder
  // keeps the ears until its flow is done, and the screen recorder keeps the
  // capture running until the user stops it. (A typed message during either
  // still works — it just doesn't disturb the recording.)
  if (!recActive() && !screenRecActive()) {
    enterMode(searchIntent ? MODES.SEARCHING : MODES.LISTENING);
    if (searchIntent) searchAc = ac;
  }

  busy = true;
  thinking = true;
  updateStatus();

  const think = ui.addThinkingBubble();

  try {
    const id = await ensureSessionId();

    // A web page can't see the browser's other tabs, so there is never a page
    // excerpt and never a list of clickable elements: page is ALWAYS empty and
    // agent is ALWAYS null. The backend treats that exactly as it treated a
    // restricted tab in the extension — she answers from the conversation and
    // the Sheet.
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
    markSetup("hello");

    remember("user", userText);
    remember("assistant", result.reply || "");

    const webCard = renderEvents(userText, result.events || []);

    // An older backend may still answer with an on-page action plan (click,
    // type, select). There is no page to act on here, so the plan is dropped
    // silently and only her spoken reply is shown — she never claims to have
    // done something she didn't.

    renderAndSpeakReply(result.reply, { question: userText, webCard });
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
          // The Library tab's own opener resets the filter and reloads the
          // full list, so tapping a row just goes there.
          onRowTap: () => tabs.goTo("library"),
          onListen: (h) => playRecordingFromHit(h),
        });
      }
    } else if (d.kind === "recordings_list") {
      ui.addRecordingsListCard({
        recordings: Array.isArray(d.recordings) ? d.recordings : [],
        onListen: (h) => playRecordingFromHit(h),
        onOpenAll: () => {
          // "See all recordings" goes to the Audio tab now — that's where
          // voice recordings live.
          tabs.goTo("audio");
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
 * The on-page acting agent and auto-read lived here in the extension:
 * plan → confirm → click/type on the user's tab → look again, plus reading
 * each new page aloud as the user moved between tabs. Both existed only to
 * drive OTHER tabs, which a web page cannot see or touch, so both are gone
 * rather than stubbed. If the backend still returns an action plan, sendTurn
 * ignores it and speaks her reply — she never reports an action that didn't
 * happen.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Library view — the Sheet, browsable and editable (formerly "memory")
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

// True while the Library is showing the Video filter — those rows come from
// the LOCAL IndexedDB store, not the Sheet, so they render through their own
// path and leaving the filter needs a reload of the normal entries.
let memShowingVideo = false;

// The Library's filter pills. Audio (voice recordings) and Video (local
// clips) each need their own source; every other filter is a client-side
// re-slice of the already-loaded list. Return true when we take over loading
// so ui.js doesn't also re-render.
function onMemFilterChange(filter) {
  if (filter === "audio") {
    memShowingVideo = false;
    memShowingRecordings = true;
    loadRecordings();
    return true;
  }
  if (filter === "video") {
    memShowingRecordings = false;
    memShowingVideo = true;
    loadVideosInto("library");
    return true;
  }
  if (memShowingRecordings || memShowingVideo) {
    // Coming back from Audio or Video — reload the normal Sheet entries.
    memShowingRecordings = false;
    memShowingVideo = false;
    loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
    return true;
  }
  return false; // pure client-side filter — let ui.js re-slice
}

// Reload whichever list the Library is currently showing — each source has its
// own loader, so a single delete/edit must refresh the right one.
function reloadMemoryView() {
  if (memShowingVideo) loadVideosInto("library");
  else if (memShowingRecordings) loadRecordings();
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
 * Audio tab — the Record button's screen. The list below it is the same
 * data the Library's Audio filter loads (the recordings sheet); tapping a
 * row plays it in the panel. Loading this list NEVER touches the recorder
 * or the mode — it is a plain fetch-and-render.
 * ------------------------------------------------------------------ */
let audioListSeq = 0;

async function loadAudioTab() {
  const seq = ++audioListSeq;
  ui.audioListLoading();
  try {
    const recs = await api.listRecordings({ limit: 100 });
    if (seq !== audioListSeq) return;
    markSetup("memory");
    const list = Array.isArray(recs) ? recs : [];
    ui.setAudioSubtitle(
      (list.length === 1 ? "1 voice recording" : list.length + " voice recordings") +
        " · tap any to play it here"
    );
    ui.renderAudioList(list, { onListen: (h) => playRecordingFromHit(h) });
  } catch (_) {
    if (seq !== audioListSeq) return;
    ui.setAudioSubtitle("Voice recordings · saved to your Drive");
    ui.renderAudioList([], {});
    ui.showUndoToast({ label: "Couldn't load your recordings — check your connection." });
  }
}

/* ------------------------------------------------------------------ *
 * Video tab — the local library of screen recordings.
 *
 * Saving a screen recording still downloads it to the computer — through a
 * hidden <a download> now, with the same filename. On top of that, a copy is kept
 * in IndexedDB (videostore.js) so it can be replayed here — with a title, the
 * date, its length, its file size and a still frame for the thumbnail. The
 * local store is capped at 2 GB and nothing is ever evicted behind the user's
 * back: they're warned BEFORE recording when it's full. No video is ever
 * uploaded anywhere — not the backend, not Drive.
 * ------------------------------------------------------------------ */
let videoListSeq = 0;

function videoTitleNow() {
  const d = new Date();
  let stamp = "";
  try {
    // Same Pacific display clock as every other timestamp on screen, so a
    // title and the date beside it can never disagree.
    stamp = d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: ui.DISPLAY_TZ,
    });
  } catch (_) {
    stamp = d.toISOString().slice(0, 16).replace("T", " ");
  }
  return "Screen recording — " + stamp;
}

// One renderer, two homes: the Video tab's list and the Library's Video filter.
async function loadVideosInto(where) {
  const seq = ++videoListSeq;
  const intoLibrary = where === "library";
  if (intoLibrary) ui.memLoading();
  else ui.videoListLoading();
  let list = [];
  let quota = { used: 0, cap: videostore.CAP_BYTES, free: videostore.CAP_BYTES };
  try {
    list = await videostore.listVideos();
    quota = await videostore.usage();
  } catch (err) {
    if (seq !== videoListSeq) return;
    const msg = "I couldn't open the local video library in this browser.";
    if (intoLibrary) ui.memError(msg);
    else ui.setVideoQuota(msg, true);
    return;
  }
  if (seq !== videoListSeq) return;

  const container = intoLibrary ? ui.els.memList : ui.els.videoList;
  ui.renderVideoRows(container, list, {
    onPlay: (v, body) => playLocalVideo(v, body),
    onDelete: (v) => deleteLocalVideo(v),
    fmtSize: videostore.fmtBytes,
    fmtLen: videostore.fmtLength,
  });

  const usedLine =
    videostore.fmtBytes(quota.used) + " of " + videostore.fmtBytes(quota.cap) + " used here";
  if (intoLibrary) {
    ui.setMemorySubtitleText(
      (list.length === 1 ? "1 screen recording" : list.length + " screen recordings") +
        " · kept on this computer"
    );
    // The Library footer tells the truth per filter: videos never leave here.
    ui.setSyncedFooter("Screen recordings stay in this browser — never uploaded · " + usedLine);
  } else {
    ui.setVideoSubtitle(
      (list.length === 1 ? "1 screen recording" : list.length + " screen recordings") +
        " · " +
        usedLine
    );
    ui.setVideoQuota(videoQuotaLine(quota), quota.free <= 0);
  }
}

function videoQuotaLine(quota) {
  if (quota.free <= 0) {
    return (
      "The local video library is full (" +
      videostore.fmtBytes(quota.cap) +
      "). New recordings will still download to your computer, but I can't keep a copy to play here until you delete some below."
    );
  }
  return (
    videostore.fmtBytes(quota.free) +
    " free of " +
    videostore.fmtBytes(quota.cap) +
    ". Every recording also downloads to your computer — these copies are only so you can play them back here."
  );
}

// Play a local clip inside its expanded row.
async function playLocalVideo(v, body) {
  try {
    const blob = await videostore.getVideoBlob(v.id);
    if (!blob) {
      ui.videoPlayerError(body, "That local copy is gone. The file you saved on your computer is fine.");
      return;
    }
    // Sharon's voice and a playing recording never overlap.
    if (speech.isSpeaking()) speech.stopSpeaking();
    pausePlaybackForUser();
    ui.mountVideoPlayer(body, URL.createObjectURL(blob));
  } catch (_) {
    ui.videoPlayerError(body, "I couldn't open that recording just now — try again in a moment.");
  }
}

// Delete the LOCAL copy only. The downloaded file on the computer is a
// separate file and is never touched.
async function deleteLocalVideo(v) {
  try {
    await videostore.deleteVideo(v.id);
    ui.showUndoToast({
      label: "Deleted my copy — the file on your computer is untouched.",
      duration: 5000,
    });
  } catch (_) {
    ui.showUndoToast({ label: "Couldn't delete that copy — try again in a moment." });
  }
  await loadVideosInto(memShowingVideo && ui.libraryOpen() ? "library" : "video");
}

// Keep a local copy of a finished screen recording, alongside the download
// that has already been handed to Chrome. Best-effort and non-blocking: if it
// doesn't fit, or IndexedDB refuses, the user is told plainly — the downloaded
// file is unaffected either way.
async function keepLocalVideoCopy(blob, durationSeconds) {
  if (!blob || !blob.size) return;
  try {
    // One decode pass gives us the still frame AND the real length (the trim
    // path knows it already; the untouched-blob fallbacks don't).
    const { thumb, duration } = await videostore.probeClip(blob, durationSeconds);
    const res = await videostore.saveVideo({
      blob,
      title: videoTitleNow(),
      durationSeconds: duration || durationSeconds,
      thumb,
    });
    if (!res.ok) {
      if (res.reason === "full") {
        ui.showUndoToast({
          label: "Saved to your computer. No room here (2 GB) to keep a copy — delete some on the Video tab.",
          duration: 7000,
        });
      } else if (res.reason !== "empty") {
        ui.showUndoToast({
          label: "Saved to your computer, but I couldn't keep a copy to play here.",
          duration: 6000,
        });
      }
      return;
    }
  } catch (_) {
    ui.showUndoToast({
      label: "Saved to your computer, but I couldn't keep a copy to play here.",
      duration: 6000,
    });
    return;
  }
  // Refresh whichever list is on screen so the new clip appears immediately.
  if (ui.libraryOpen() && memShowingVideo) loadVideosInto("library");
  else loadVideosInto("video");
}

// Before a screen recording starts: if the 2 GB local library is full, say so
// NOW rather than silently dropping the local copy 20 minutes from now.
async function warnIfVideoStoreFull() {
  try {
    const quota = await videostore.usage();
    if (quota.free > 0) return;
    hint(
      "The Video tab's 2 GB library is full — this will still download to your computer, but I can't keep a copy to play here."
    );
  } catch (_) {
    /* the store is unavailable — the download path is unaffected */
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
      "Click the lock icon by Chrome's address bar, allow the microphone, then tap record again."
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

  // The manager exits whatever came before (SCREEN clears its snapshot,
  // SEARCHING aborts its call), then runs enterRecordingMode below.
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
  // "Record mid-anything": abandon the in-flight assist cleanly — its finally
  // tidies the UI.
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
    // The distilled-notes card is Sharon's answer to this recording and it
    // lives in the thread, so bring the Sharon tab forward to show it. Pure
    // navigation, after the flow has finished — nothing about the recording,
    // the upload or the mode depends on it.
    tabs.goTo("chat");
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
    // just saved instead of leaving the model to guess from page context.
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
    loadAudioTab(); // the new recording belongs in the Audio tab's list
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
 * Screen recorder — records the CURRENT DESKTOP (screen video + its system/
 * desktop audio, NEVER the microphone, so other apps keep full mic access) up
 * to 30 minutes, then lets the user trim and download the clip.
 *
 * In the extension this ran inside a BACKGROUND offscreen document so it
 * survived the side panel being collapsed, with a red dot on the toolbar icon.
 * A web page has no background document and no toolbar icon, so the recorder
 * runs HERE — getDisplayMedia + MediaRecorder in this page. The consequence is
 * deliberate and accepted: a recording keeps going only while this tab stays
 * open, and closing or reloading the page ends it. Chrome's own "Stop sharing"
 * bar still stops it, and the red "Recording" pill in the header is now the
 * only recording indicator.
 *
 * It lives in its own SCREEN_REC mode so Sharon stays quiet (mic input
 * dropped) while a recording or its review owns the screen; the mode manager
 * keeps that exclusive with the voice recorder.
 * ------------------------------------------------------------------ */
let screenRecPhase = "idle"; // idle | recording | stopping | reviewing | trimming
let screenRecPaused = false; // whether the in-progress recording is paused
let screenRecStartAtEpoch = 0; // virtual start (now − this === recorded ms)
let screenRecTimerInt = null; // the local MM:SS display timer

// The live capture. The pause bookkeeping mirrors what the offscreen document
// used to do: screenPausedAccumMs is recorded time banked before the current
// running segment, screenSegStart is when that segment began (0 while paused).
// So the 30-minute cap is spent on RECORDED time and pausing never burns it.
let screenStream = null; // the getDisplayMedia stream
let screenRecorder = null; // the MediaRecorder writing this recording
let screenChunks = []; // its 1-second chunks
let screenCapTimer = null; // watches the 30-minute cap
let screenPausedAccumMs = 0;
let screenSegStart = 0;
let screenStopRecordedMs = 0; // recorded length, frozen the moment Stop is hit

// Review/trim step — inserted BETWEEN "recording finished" and "download".
// The finished clip is assembled from the chunks above; then we stay in
// SCREEN_REC and show a preview + trimmer until the user saves or discards.
let screenReviewBlob = null; // the recorded blob (trim source + untouched save)
let screenReviewUrl = null; // preview object URL — revoked on review teardown
let screenReviewCard = null; // the ui controller for the review card
let screenReviewFilename = ""; // the filename both save paths use
let screenTrimVideo = null; // off-screen <video> replaying the kept region
let screenTrimStream = null; // the captureStream() feeding the trim recorder
let screenTrimRecorder = null; // MediaRecorder re-recording the kept region in real time
let screenTrimTimer = null; // drives the stop check + progress label while trimming
let screenTrimStartWall = 0; // wall clock — a stall fallback so trimming always ends

// The one test for "the screen recorder flow owns the screen": the mode word.
function screenRecActive() {
  return inMode(MODES.SCREEN_REC);
}

// Recorded time so far, excluding any paused stretches.
function screenRecordedMs() {
  if (screenRecPhase !== "recording") return 0;
  return screenRecPaused
    ? screenPausedAccumMs
    : screenPausedAccumMs + (Date.now() - screenSegStart);
}

// Video codecs in order of preference — vp9 is best, vp8 the fallback, plain
// webm the floor. Used by both the capture and the trim re-record.
function pickScreenRecorderMime() {
  if (!window.MediaRecorder) return null;
  for (const m of ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// Stop every track on a stream (idempotent — stop() is safe to call twice).
function stopStreamTracks(stream) {
  if (!stream || !stream.getTracks) return;
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch (_) {
      /* ignore */
    }
  }
}

// "sharon-screen-YYYY-MM-DD-HHMM.webm" in the user's local clock.
function screenRecFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes());
  return "sharon-screen-" + stamp + ".webm";
}

// Save the finished video to the computer. The extension used
// chrome.downloads (which offered a Save-As dialog); a web page has one way to
// hand a file over, so this is a hidden <a download> pointed at the blob URL.
// The filename is unchanged.
//
// The caller hands ownership of `url` to this function: it revokes the object
// URL once the download has had time to read the blob, never before — revoking
// a blob: URL mid-download would break it. Callers therefore create a
// dedicated URL per download and never revoke it themselves.
function downloadScreenRecording(url, filename) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (_) {
    /* nothing more we can do */
  }
  // The anchor read the blob synchronously on click; revoke after a grace
  // window so a slow save still has the data.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
  }, 30000);
}

// The screen-record button: open the browser's own screen picker and start
// recording. We enter SCREEN_REC + show the live card only once a real capture
// is running — so a cancelled picker leaves Sharon exactly where she was.
async function startScreenRecordingCmd() {
  if (screenRecActive() || screenRecPhase !== "idle") return;
  if (recActive()) {
    // The voice recorder owns the mic until it's done.
    hint("I'm recording your voice right now — tap the round button to stop.");
    return;
  }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
    reportProblem(
      "screen recording isn't available here.",
      "It needs a recent Chrome or Edge served over https or http://localhost — check the address bar, then reload me."
    );
    return;
  }
  const mime = pickScreenRecorderMime();
  if (!mime) {
    reportProblem(
      "screen recording isn't supported in this browser.",
      "Chrome should support it — try updating Chrome, then reload me."
    );
    return;
  }
  // Warn BEFORE recording if the 2 GB local library has no room left — never
  // silently drop the local copy after the fact.
  await warnIfVideoStoreFull();

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    const name = (err && err.name) || "";
    // The user dismissed the picker — nothing to say; the button is ready to
    // try again.
    if (name === "NotAllowedError" || name === "AbortError") return;
    reportProblem(
      "the screen recording ran into a problem" + (name ? " (" + name + ")" : "") + ".",
      "Tap Record screen on the Video tab to try again."
    );
    return;
  }
  // The world may have moved on while the picker was open.
  if (recActive() || screenRecPhase !== "idle") {
    stopStreamTracks(stream);
    return;
  }

  let recorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (_) {
    stopStreamTracks(stream);
    reportProblem(
      "I couldn't start the screen recorder.",
      "Give it a second and tap Record screen on the Video tab again."
    );
    return;
  }

  screenStream = stream;
  screenRecorder = recorder;
  screenChunks = [];
  recorder.addEventListener("dataavailable", (ev) => {
    if (ev.data && ev.data.size) screenChunks.push(ev.data);
  });
  recorder.addEventListener("stop", finalizeScreenRecording, { once: true });
  // The browser's own "Stop sharing" bar ends the display video track — treat
  // that exactly like tapping Stop.
  const videoTrack = (stream.getVideoTracks() || [])[0];
  if (videoTrack)
    videoTrack.addEventListener("ended", () => stopScreenRecordingCmd(), { once: true });

  screenPausedAccumMs = 0;
  screenSegStart = Date.now();
  try {
    recorder.start(1000); // 1s chunks — a crash loses at most a second
  } catch (_) {
    stopStreamTracks(stream);
    screenStream = null;
    screenRecorder = null;
    screenChunks = [];
    reportProblem(
      "I couldn't start the screen recorder.",
      "Give it a second and tap Record screen on the Video tab again."
    );
    return;
  }
  onScreenStarted(screenSegStart);

  // 30-minute hard cap — on RECORDED time, so pausing doesn't burn the budget.
  screenCapTimer = setInterval(() => {
    if (screenRecordedMs() >= RECORD_MAX_MS) stopScreenRecordingCmd();
  }, 1000);
}

// Stop the recording (the live card's Stop button, the keyboard shortcut, the
// browser's own "Stop sharing" bar, or the 30-minute cap). The recorder's own
// "stop" event then assembles the clip and drives the review step.
function stopScreenRecordingCmd() {
  if (screenRecPhase !== "recording") return;
  screenStopRecordedMs = screenRecordedMs(); // freeze the length before the phase moves
  screenRecPhase = "stopping";
  if (screenCapTimer) {
    clearInterval(screenCapTimer);
    screenCapTimer = null;
  }
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  const rec = screenRecorder;
  try {
    if (rec && rec.state !== "inactive") rec.stop();
    else finalizeScreenRecording();
  } catch (_) {
    finalizeScreenRecording();
  }
}

// Pause ↔ resume, from the keyboard shortcut. Keeps the MediaRecorder and the
// recorded-time bookkeeping in step.
function togglePauseScreenRecording() {
  if (screenRecPhase !== "recording") return;
  const rec = screenRecorder;
  if (!screenRecPaused) {
    try {
      if (rec && rec.state === "recording") rec.pause();
    } catch (_) {
      /* ignore */
    }
    screenPausedAccumMs += Date.now() - screenSegStart;
    screenSegStart = 0;
    onScreenPaused(screenPausedAccumMs);
  } else {
    try {
      if (rec && rec.state === "paused") rec.resume();
    } catch (_) {
      /* ignore */
    }
    screenSegStart = Date.now();
    // virtual start: now − this === recorded ms, so the display timer needs no
    // pause math of its own.
    onScreenResumed(screenSegStart - screenPausedAccumMs);
  }
}

// The recorder finished winding down: assemble the clip and hand it to the
// review step. A teardown (the page closing, a forced mode exit) moves the
// phase off "stopping" first, and then the clip is dropped with everything
// else rather than popping a review card over a torn-down screen.
function finalizeScreenRecording() {
  if (screenRecPhase !== "stopping") {
    screenChunks = [];
    return;
  }
  const mime = (screenRecorder && screenRecorder.mimeType) || "video/webm";
  const blob = new Blob(screenChunks, { type: mime });
  screenChunks = [];
  stopStreamTracks(screenStream);
  screenStream = null;
  screenRecorder = null;
  const durationSeconds = Math.min(
    Math.round(screenStopRecordedMs / 1000),
    Math.round(RECORD_MAX_MS / 1000)
  );
  onScreenStopped({ blob, durationSeconds, mime });
}

/* --- the live card's state --- */

// Run the local MM:SS display timer off the shared (virtual) start time.
function startScreenRecDisplayTimer() {
  if (screenRecTimerInt) clearInterval(screenRecTimerInt);
  screenRecTimerInt = setInterval(() => {
    const elapsed = Date.now() - screenRecStartAtEpoch;
    ui.setScreenRecTimer(fmtClock(Math.min(elapsed, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
  }, REC_TIMER_TICK_MS);
}

// A recording actually started — enter SCREEN_REC and show the live card. The
// 30-minute cap runs off screenCapTimer; this is display only.
function onScreenStarted(startAtEpoch) {
  if (recActive()) return; // the voice recorder owns everything
  if (screenRecPhase !== "idle") return; // already recording/reviewing
  if (!screenRecActive()) enterMode(MODES.SCREEN_REC);
  screenRecPhase = "recording";
  screenRecPaused = false;
  screenRecStartAtEpoch = Number(startAtEpoch) || Date.now();
  ui.setScreenRecTimer("00:00 / " + fmtClock(RECORD_MAX_MS));
  ui.showScreenRecorder();
  ui.setScreenRecPaused(false);
  startScreenRecDisplayTimer();
  updateStatus();
}

// Paused via the keyboard shortcut — freeze the display timer at the recorded
// time and show the paused state. (The 30-minute budget is frozen too.)
function onScreenPaused(recordedMs) {
  if (screenRecPhase !== "recording") return;
  screenRecPaused = true;
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  const ms = Math.max(0, Number(recordedMs) || 0);
  ui.setScreenRecTimer(fmtClock(Math.min(ms, RECORD_MAX_MS)) + " / " + fmtClock(RECORD_MAX_MS));
  ui.setScreenRecPaused(true);
  updateStatus();
}

// Resumed via the keyboard shortcut — restart the display timer off the new
// virtual start time.
function onScreenResumed(startAtEpoch) {
  if (screenRecPhase !== "recording") return;
  screenRecPaused = false;
  screenRecStartAtEpoch = Number(startAtEpoch) || Date.now();
  ui.setScreenRecPaused(false);
  startScreenRecDisplayTimer();
  updateStatus();
}

// A recording finished (Stop, the browser's Stop-sharing bar, or the 30-minute
// cap) and its clip is assembled — show the review/trim card.
function onScreenStopped(info) {
  if (screenRecPhase === "reviewing" || screenRecPhase === "trimming") return; // already handled
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  const blob = info && info.blob;
  if (!blob || !blob.size) {
    if (screenRecActive()) enterMode(MODES.LISTENING);
    else screenRecPhase = "idle";
    reportProblem(
      "the screen recording came out empty, so there was nothing to save.",
      "Tap Record screen on the Video tab and try again."
    );
    updateStatus();
    return;
  }
  if (!screenRecActive()) enterMode(MODES.SCREEN_REC);
  screenReviewBlob = blob;
  screenReviewFilename = screenRecFilename();
  screenReviewUrl = URL.createObjectURL(blob);
  screenRecPhase = "reviewing";
  // The review/trim card lives in the thread, so bring the Sharon tab forward
  // to show it. Pure navigation — the mode stays SCREEN_REC and the clip is
  // untouched; it is the recording ENDING that moves the view, never the other
  // way round.
  tabs.goTo("chat");
  screenReviewCard = ui.addScreenReviewCard({
    url: screenReviewUrl,
    onSave: (start, end, dur) => saveScreenReview(start, end, dur),
    onDiscard: () => discardScreenReview(),
  });
  updateStatus();
}

// SCREEN_REC's enter routine — the capture itself is started by the caller,
// so entering the mode just makes Sharon go quiet (drop mic input, pause any
// playback, abandon an in-flight turn) while a recording or its review owns
// the screen. The live/review UI is set by the callers above.
function enterScreenRecMode() {
  pausePlaybackForUser();
  if (abortController) {
    try {
      abortController.abort();
    } catch (_) {
      /* ignore */
    }
  }
  resetCapture();
  updateStatus();
}

// Release the REVIEW/TRIM resources — the trim re-record, the off-screen
// video, the preview object URL, and the review card. Idempotent and safe to
// call twice; the download's own dedicated URL is revoked by the download
// path, never here.
function teardownScreenReview() {
  if (screenTrimTimer) {
    clearInterval(screenTrimTimer);
    screenTrimTimer = null;
  }
  if (screenTrimRecorder) {
    try {
      if (screenTrimRecorder.state !== "inactive") screenTrimRecorder.stop();
    } catch (_) {
      /* ignore */
    }
    screenTrimRecorder = null;
  }
  stopStreamTracks(screenTrimStream);
  screenTrimStream = null;
  if (screenTrimVideo) {
    try {
      screenTrimVideo.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      screenTrimVideo.removeAttribute("src");
      screenTrimVideo.load();
    } catch (_) {
      /* ignore */
    }
    try {
      if (screenTrimVideo.parentNode) screenTrimVideo.parentNode.removeChild(screenTrimVideo);
    } catch (_) {
      /* ignore */
    }
    screenTrimVideo = null;
  }
  if (screenReviewCard) {
    try {
      screenReviewCard.remove();
    } catch (_) {
      /* ignore */
    }
    screenReviewCard = null;
  }
  if (screenReviewUrl) {
    try {
      URL.revokeObjectURL(screenReviewUrl);
    } catch (_) {
      /* ignore */
    }
    screenReviewUrl = null;
  }
  screenReviewBlob = null;
  screenReviewFilename = "";
  screenTrimStartWall = 0;
}

// SCREEN_REC's exit routine — idempotent and safe to call twice. In the
// extension the recording lived in a background document, so leaving the mode
// deliberately left it running. It runs in THIS page now, so leaving the mode
// really does end it: the capture and the recorder are force-stopped here
// along with the review/trim resources, the display timer and the live card.
// The phase is cleared FIRST so the recorder's own "stop" event knows the clip
// is being abandoned and doesn't raise a review card over a torn-down screen.
function forceScreenRecIdle() {
  if (screenCapTimer) {
    clearInterval(screenCapTimer);
    screenCapTimer = null;
  }
  if (screenRecTimerInt) {
    clearInterval(screenRecTimerInt);
    screenRecTimerInt = null;
  }
  screenRecPaused = false;
  const wasLive = screenRecPhase === "recording" || screenRecPhase === "stopping";
  if (screenRecPhase !== "idle") {
    screenRecPhase = "idle";
    ui.hideScreenRecorder();
  }
  if (wasLive && screenRecorder) {
    try {
      if (screenRecorder.state !== "inactive") screenRecorder.stop();
    } catch (_) {
      /* ignore */
    }
  }
  screenRecorder = null;
  screenChunks = [];
  stopStreamTracks(screenStream);
  screenStream = null;
  teardownScreenReview();
}

// Discard — nothing is saved. Leaving the mode revokes the preview URL and
// removes the card (forceScreenRecIdle).
function discardScreenReview() {
  if (!screenRecActive()) return;
  enterMode(MODES.LISTENING);
  updateStatus();
}

// Save the chosen region. If the handles are effectively untouched (start ≈ 0
// AND end ≈ full duration, within ~0.3s), skip re-encoding and download the
// ORIGINAL blob as-is — instant and lossless. Otherwise trim for real.
function saveScreenReview(startSec, endSec, durationSec) {
  if (screenRecPhase !== "reviewing") return;
  const TOL = 0.3;
  const untouched =
    !isFinite(durationSec) ||
    durationSec <= 0 ||
    (startSec <= TOL && endSec >= durationSec - TOL);

  const filename = screenReviewFilename || screenRecFilename();
  if (untouched) {
    // A dedicated download URL (the download path revokes it when it settles);
    // the preview URL is revoked separately by the mode-exit teardown.
    if (screenReviewBlob) {
      downloadScreenRecording(URL.createObjectURL(screenReviewBlob), filename);
      // ALSO keep a local copy so the Video tab can replay it. Fire and
      // forget — the download above is the archive and is already under way.
      keepLocalVideoCopy(screenReviewBlob, durationSec);
    }
    enterMode(MODES.LISTENING);
    updateStatus();
    return;
  }
  trimAndDownload(startSec, endSec, filename);
}

// A real trim: replay ONLY the kept region into a fresh MediaRecorder via
// video.captureStream() (which carries the audio track), in real time, then
// download the result. Runs inside SCREEN_REC; the card shows progress and its
// buttons stay disabled until it finishes.
async function trimAndDownload(startSec, endSec, filename) {
  const mime = pickScreenRecorderMime();
  const sourceBlob = screenReviewBlob;

  // Save the whole clip instead of losing it if we can't trim here.
  const saveWholeInstead = () => {
    if (sourceBlob) {
      downloadScreenRecording(URL.createObjectURL(sourceBlob), filename);
      keepLocalVideoCopy(sourceBlob, 0);
    }
    enterMode(MODES.LISTENING);
    updateStatus();
  };
  if (!mime || !sourceBlob) {
    saveWholeInstead();
    return;
  }

  screenRecPhase = "trimming";
  const total = Math.max(0, endSec - startSec);
  if (screenReviewCard)
    screenReviewCard.setTrimming(
      "Trimming… this takes about as long as the kept clip — " + fmtClock(total * 1000) + " left"
    );
  updateStatus();

  // Off-screen but RENDERED video (display:none stops frame output to
  // captureStream, so it's positioned off-screen instead). Muted so it makes
  // no sound in the room; captureStream still carries the audio track.
  const v = document.createElement("video");
  v.className = "srv-offscreen";
  v.src = screenReviewUrl; // same blob as the preview
  v.muted = true;
  v.playsInline = true;
  document.body.appendChild(v);
  screenTrimVideo = v;

  try {
    await new Promise((res, rej) => {
      v.addEventListener("loadedmetadata", () => res(), { once: true });
      v.addEventListener("error", () => rej(new Error("load")), { once: true });
    });
  } catch (_) {
    saveWholeInstead();
    return;
  }
  if (screenRecPhase !== "trimming") return; // torn down while we waited

  // Seek to the start point before we start capturing.
  try {
    await new Promise((res) => {
      v.addEventListener("seeked", () => res(), { once: true });
      try {
        v.currentTime = startSec;
      } catch (_) {
        res();
      }
    });
  } catch (_) {
    /* proceed from wherever it landed */
  }
  if (screenRecPhase !== "trimming") return;

  const capture = v.captureStream
    ? v.captureStream.bind(v)
    : v.mozCaptureStream
    ? v.mozCaptureStream.bind(v)
    : null;
  if (!capture) {
    saveWholeInstead();
    return;
  }
  let stream;
  let recorder;
  try {
    stream = capture();
    recorder = new MediaRecorder(stream, { mimeType: mime });
  } catch (_) {
    saveWholeInstead();
    return;
  }
  screenTrimStream = stream;
  screenTrimRecorder = recorder;
  const chunks = [];
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });

  let stopped = false;
  const stopTrim = () => {
    if (stopped) return;
    stopped = true;
    if (screenTrimTimer) {
      clearInterval(screenTrimTimer);
      screenTrimTimer = null;
    }
    try {
      v.pause();
    } catch (_) {
      /* ignore */
    }
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch (_) {
      /* ignore */
    }
  };

  recorder.addEventListener(
    "stop",
    () => {
      const trimmed = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      // Hand a dedicated URL to the download path (it revokes on settle); the
      // preview URL + off-screen video are freed by the mode-exit teardown.
      // Whichever blob is downloaded is also the one kept locally.
      if (trimmed.size) {
        downloadScreenRecording(URL.createObjectURL(trimmed), filename);
        keepLocalVideoCopy(trimmed, total);
      } else if (sourceBlob) {
        downloadScreenRecording(URL.createObjectURL(sourceBlob), filename);
        keepLocalVideoCopy(sourceBlob, 0);
      }
      enterMode(MODES.LISTENING);
      updateStatus();
    },
    { once: true }
  );

  screenTrimStartWall = Date.now();
  try {
    recorder.start(1000);
  } catch (_) {
    saveWholeInstead();
    return;
  }
  try {
    await v.play();
  } catch (_) {
    /* play() may reject; the timer below still drives the stop */
  }

  // Stop when playback reaches the end handle (or the clip ends), with a
  // wall-clock stall fallback so trimming can never hang forever.
  screenTrimTimer = setInterval(() => {
    const cur = v.currentTime;
    const left = Math.max(0, endSec - cur);
    if (screenReviewCard) screenReviewCard.updateTrimming("Trimming… " + fmtClock(left * 1000) + " left");
    const elapsedWall = Date.now() - screenTrimStartWall;
    if (cur >= endSec - 0.03 || v.ended || elapsedWall > total * 1000 + 4000) {
      stopTrim();
    }
  }, 100);
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

// SCREEN — "one look at this tab", with its snapshot, its banner and its
// enter/exit routines — lived here. A web page can't read the browser's other
// tabs, so the mode is gone and never registered with the manager.

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
 * DICTATING lived here: the Voice Input Overlay (voice-input/) typed the
 * user's speech into a text field on some OTHER web page, and Sharon stood
 * down so two recognizers never fought over the microphone. There is no
 * overlay and no other page to dictate into, so the mode is gone. Dictating
 * into a NOTE is untouched — that runs through speech.js's own dictation
 * contract from notes.js, and never needed this mode.
 * ------------------------------------------------------------------ */

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
  if (screenRecActive()) {
    hint("I'm recording your screen right now — tap the screen-record button to stop.");
    return;
  }
  if (!speech.speechRecognitionAvailable()) {
    reportProblem(
      "Voice input isn't available in this browser.",
      "Type to me in the box below instead — everything works the same way, and I'll still answer out loud."
    );
    return;
  }
  if (speech.isMicBlocked()) {
    showConversationForVoice(); // retrying the mic is turning the assistant on
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
  const unmuting = speech.isMicMuted(); // read once — closing views must not race the toggle
  if (unmuting) showConversationForVoice(); // this tap turns her on: show her
  speech.setMicMuted(!unmuting);
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
        "Couldn't reach your Sheet — open config.js, check PROXY_URL and API_KEY match your Apps Script deployment, then reload me."
      );
  }
}

function applySettingsToUI() {
  const e = ui.els;
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

/* ------------------------------------------------------------------ *
 * Keyboard shortcuts — the extension registered these with chrome.commands,
 * which made them work browser-wide and let Chrome rebind them. On a web page
 * they are plain keydown listeners, so they work while Sharon is the focused
 * tab and the keys are fixed. All three are modifier chords that type nothing,
 * so they never interfere with typing in the composer, the Notes editor or the
 * search box.
 * ------------------------------------------------------------------ */
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(
  (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent
);
const SHORTCUTS = {
  activate: { code: "KeyY", label: IS_MAC ? "⌘ ⇧ Y" : "Ctrl + Shift + Y" },
  toggleScreenRec: { code: "Digit9", label: IS_MAC ? "⌘ ⇧ 9" : "Ctrl + Shift + 9" },
  pauseScreenRec: { code: "Digit8", label: IS_MAC ? "⌘ ⇧ 8" : "Ctrl + Shift + 8" },
};

// The manifest used Command+Shift on Mac and Ctrl+Shift everywhere else; match
// that exactly. ev.code is read rather than ev.key because Shift turns "9"
// into "(" on a US layout.
function isShortcutChord(ev, code) {
  if (ev.code !== code || !ev.shiftKey || ev.altKey || ev.repeat) return false;
  return IS_MAC ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
}

function refreshShortcut() {
  const set = (el, key) => {
    if (el) el.textContent = SHORTCUTS[key].label;
  };
  set(ui.els.shortcutValue, "activate");
  set(ui.els.screenRecShortcutValue, "toggleScreenRec");
  set(ui.els.screenPauseShortcutValue, "pauseScreenRec");
}

function wireShortcuts() {
  document.addEventListener("keydown", (ev) => {
    // "Activate Sharon" is an explicit summons — the one non-click path
    // allowed to wake the voice assistant.
    if (isShortcutChord(ev, SHORTCUTS.activate.code)) {
      ev.preventDefault();
      showConversationForVoice();
      speech.retryMic();
      updateStatus();
      return;
    }
    if (isShortcutChord(ev, SHORTCUTS.toggleScreenRec.code)) {
      ev.preventDefault();
      runModeAction(async () => {
        if (screenRecPhase === "recording") stopScreenRecordingCmd();
        else if (screenRecPhase === "idle") await startScreenRecordingCmd();
      });
      return;
    }
    if (isShortcutChord(ev, SHORTCUTS.pauseScreenRec.code)) {
      ev.preventDefault();
      togglePauseScreenRecording();
    }
  });
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

  // The action buttons, each on the screen it belongs to (and mute in the
  // header):
  //   header mic      → mute / unmute
  //   Audio tab       → start / stop a voice memo
  //   Video tab       → start / stop a screen recording
  if (e.micBtn) e.micBtn.addEventListener("click", toggleMic);
  if (e.recordBtn)
    e.recordBtn.addEventListener("click", () =>
      runModeAction(async () => {
        if (screenRecActive()) {
          // The screen recorder owns the capture until the user stops it.
          hint("I'm recording your screen right now — tap the screen-record button to stop.");
          return;
        }
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
  // Screen record: start/stop the in-page recorder, mirroring the voice record
  // button. The recording lasts as long as this tab stays open.
  if (e.screenRecBtn)
    e.screenRecBtn.addEventListener("click", () =>
      runModeAction(async () => {
        if (screenRecPhase === "recording") {
          stopScreenRecordingCmd();
        } else if (screenRecPhase === "reviewing") {
          hint("Choose Save or Discard on your recording below.");
        } else if (screenRecPhase === "trimming") {
          hint("Trimming your clip — one moment.");
        } else {
          await startScreenRecordingCmd();
        }
      })
    );
  if (e.recStop) e.recStop.addEventListener("click", () => runModeAction(async () => stopRecording()));
  if (e.screenRecStop)
    e.screenRecStop.addEventListener("click", () => runModeAction(async () => stopScreenRecordingCmd()));
  // Leaving the page ends BOTH recordings — they run here, in memory, and
  // nothing outlives the tab. (In the extension the screen recording lived in
  // a background document and deliberately survived; there is nowhere for it
  // to survive now, which is why this is the accepted trade.)
  window.addEventListener("pagehide", () => {
    if (recState === "recording" && mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
    if (screenCapTimer) {
      clearInterval(screenCapTimer);
      screenCapTimer = null;
    }
    if (screenRecTimerInt) {
      clearInterval(screenRecTimerInt);
      screenRecTimerInt = null;
    }
    if (screenRecorder && screenRecorder.state !== "inactive") {
      try {
        screenRecorder.stop();
      } catch (_) {
        /* ignore */
      }
    }
    stopStreamTracks(screenStream);
    teardownScreenReview();
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
  if (e.memoryBtn) e.memoryBtn.addEventListener("click", () => tabs.goTo("library"));
  if (e.settingsBtn)
    e.settingsBtn.addEventListener("click", () => {
      applySettingsToUI();
      refreshSetupRows();
      refreshShortcut();
      ui.openSettings();
    });
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", ui.closeSettings));
  if (e.scrim) e.scrim.addEventListener("click", ui.closeSettings);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (ui.settingsOpen()) ui.closeSettings();
    else if (ui.libraryOpen()) {
      // Escape backs out one layer at a time: selection first, then back to
      // the Sharon tab. Navigation only — no mode is touched.
      if (ui.memSelectActive()) ui.exitMemSelect();
      else tabs.goTo("chat");
    }
  });

  // Library search (debounced, live filtering via the backend).
  let memSearchTimer = null;
  if (e.memSearchInput)
    e.memSearchInput.addEventListener("input", () => {
      const q = e.memSearchInput.value.trim();
      // Searching always works against the full Sheet list (a keyword search
      // also surfaces recording transcripts), so drop the Audio/Video filters.
      if (memShowingRecordings || memShowingVideo) {
        memShowingRecordings = false;
        memShowingVideo = false;
        ui.selectFilter("all");
      }
      if (memSearchTimer) clearTimeout(memSearchTimer);
      memSearchTimer = setTimeout(() => loadMemory(q), 320);
    });

  // Preferences. The page toggles (auto-read, scroll, act on the page, confirm
  // each action) are gone with the tab reading they controlled — only the voice
  // preferences are left.
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
  // The three shortcut keycaps are read-only labels now (see wireShortcuts):
  // the keys are handled in this page and there is no browser shortcuts page
  // for a web app to send anyone to.

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
      ui.setWelcomeStep("mic", "doing", "Waiting for your browser's permission prompt — choose Allow.");
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

  // The extension listened on chrome.runtime.onMessage here for the Voice
  // Input Overlay, the "Activate Sharon" command and the background screen
  // recorder's events, and on chrome.tabs for the user moving between tabs.
  // None of those exist on a web page: the shortcuts are keydown listeners
  // (wireShortcuts) and the screen recorder reports to itself.
  wireShortcuts();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
(async function init() {
  await ensureSessionId();
  await loadSettings();
  await loadSetup();

  ui.initUI();
  ui.setMemFilterHandler(onMemFilterChange);

  // The bottom tab bar. Tapping a tab ONLY changes which screen is showing —
  // these hooks fetch and render that screen's list and nothing else. No hook
  // here starts, stops or pauses a recording, and none of them calls
  // enterMode(): tab state and mode state are separate, so a recording started
  // on the Audio or Video tab keeps running while you browse anywhere else.
  tabs.initTabs({
    onOpen: {
      library: () => {
        memShowingRecordings = false;
        memShowingVideo = false;
        ui.selectFilter("all");
        loadMemory(ui.els.memSearchInput ? ui.els.memSearchInput.value.trim() : "");
      },
      audio: () => loadAudioTab(),
      video: () => loadVideosInto("video"),
    },
  });

  // The Notes view wires its own controls; it only needs the redeploy
  // walkthrough for a stale backend, and a guard so dictation can never
  // start while a voice or screen recording owns the ears.
  notes.initNotes({
    redeploySteps: REDEPLOY_STEPS,
    canDictate: () => !recActive() && !screenRecActive(),
  });

  // The mode manager — Sharon is in exactly one mode; every feature routes
  // its entries and exits through here. Opens in LISTENING (the default), so
  // a reloaded page never resumes a stuck mode: every recorder's state is in
  // memory only, and this registration starts them clean. SCREEN and
  // DICTATING are deliberately absent — both needed the browser's other tabs,
  // so no routine is registered for them and they are never entered.
  initModes({
    routines: {
      [MODES.LISTENING]: { enter: enterListeningMode },
      [MODES.RECORDING]: { enter: enterRecordingMode, exit: forceRecorderIdle },
      [MODES.SCREEN_REC]: { enter: enterScreenRecMode, exit: forceScreenRecIdle },
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
          "I couldn't use the microphone. Click the icon by your browser's address bar, allow the microphone, then tap Allow again."
        );
      } else {
        reportProblem(
          "I couldn't access the microphone.",
          "Click the icon by your browser's address bar, allow the microphone, then tap the mic button to try again. You can type to me in the meantime."
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
  ready = true;
  applySettingsToUI();
  refreshSetupRows();

  // First run only: the welcome walkthrough. After that, setup lives in
  // Settings as three quiet status rows and never blocks the panel again.
  if (!setupComplete()) {
    refreshWelcomeSteps();
    ui.showWelcome();
  }

  // Sharon — the conversation — is the default tab, so the panel opens there
  // (data-view="chat" in the markup) unless the first-run welcome is on screen.
  // Every other screen is one tap away in the bar at the bottom.

  // The voice assistant NEVER starts on its own: whatever view is showing
  // (Notes, the welcome, the conversation), the panel opens with the mic
  // muted, and recognition is deliberately not started here. It goes live
  // only from an explicit user action — the mic button, an "Allow" button,
  // or the "Activate Sharon" shortcut (see showConversationForVoice above).
  speech.setMicMuted(true);
  updateStatus();
  watchMicPermission();

  refreshMemoryCount();

  // Restore the conversation thread from the Sheet so a reopened panel
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
