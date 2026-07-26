Sharon — the web page version
=============================

This is the Sharon Chrome extension rebuilt as an ordinary web page. Same look,
same behaviour, no extension parts. She still listens and speaks, holds a real
back-and-forth conversation, saves / searches / updates notes and tasks in your
"Speaking Assistant" Google Sheet through your Apps Script backend, records
voice memos, and records your screen.


START IT
--------
From inside this folder, run:

    python3 -m http.server 8000

Then open:

    http://localhost:8000

That is the whole setup. Any static file server works — `npx serve -l 8000`,
`php -S localhost:8000`, nginx, GitHub Pages, whatever you already have.

It MUST be served over http://localhost or https://. Opening index.html
directly as a file:// page will not work: ES modules, the microphone and screen
capture are all blocked there by the browser.

Chrome or Edge is required for the voice assistant — SpeechRecognition (the
"ears") is not available in Firefox or Safari. Everything else, including
typing to her, works anywhere.

Before she can reach her memory, config.js still needs PROXY_URL and API_KEY to
match your Apps Script deployment. That file is unchanged from the extension —
if the extension worked, this will too.


WHAT WAS REMOVED, AND WHY
-------------------------
A web page can only see itself. It cannot read, scroll or click your other
browser tabs, and it has no toolbar icon or background worker. Everything that
depended on those is gone rather than faked:

  * Reading the current tab (page.js). She no longer receives the text of
    whatever page you are on, so "what does this page say?" is answered from the
    conversation and your Sheet instead. assist() always sends an empty page.

  * The page-awareness pill ("Seeing this tab" / "Not reading this tab") and the
    "look at this tab" control it doubled as, plus its SCREEN mode.

  * Scrolling by voice ("scroll down", "go to the top", "read more"). Those
    phrases now just go to her like any other sentence.

  * The on-page action engine — click / type / select to carry out a task. If
    the backend still returns an action plan, it is ignored and only her spoken
    reply is shown. She never claims to have done something she did not do.

  * The four page preferences in Settings that controlled the above: "Read pages
    to me automatically", "Let Sharon scroll the page", "Let Sharon act on the
    page", "Ask me before each action".

  * The Voice Input Overlay (voice-input/) that dictated into text fields on
    other pages, and the DICTATING mode that stood her down for it. Dictating
    into a NOTE is untouched — that never needed any of it.

  * The toolbar icon and its red recording badge. The red "Recording" pill in
    the header is now the only recording indicator.

  * Rebinding the keyboard shortcuts. There is no browser shortcuts page for a
    web app to send you to, so the three keycaps in Settings are read-only
    labels showing the fixed keys.


WHAT CHANGED BEHIND THE SCENES
------------------------------
  * chrome.storage.local -> localStorage, through storage.js. Same key names,
    same get/set/remove shape, still promise-based.

  * chrome.downloads -> a hidden <a download>. Same filenames
    (sharon-screen-YYYY-MM-DD-HHMM.webm).

  * The background screen recorder (background.js + the offscreen document) ->
    getDisplayMedia + MediaRecorder running in this page. The one real
    difference in behaviour: a screen recording now keeps going only while this
    tab stays open. Closing or reloading the page ends it. Everything else about
    it is the same — the 30-minute cap, pause/resume, the browser's own "Stop
    sharing" bar, the trim-and-save review step, the download, and the 2 GB
    local library in IndexedDB that lets you replay clips on the Video tab.

  * chrome.commands -> plain keydown listeners in this page. Same keys, active
    while Sharon is the focused tab:

        Ctrl + Shift + Y   Activate Sharon (turn the microphone on)
        Ctrl + Shift + 9   Start / stop screen recording
        Ctrl + Shift + 8   Pause / resume screen recording

    (Cmd instead of Ctrl on a Mac.) All three are modifier chords that type
    nothing, so they never interfere with typing in the composer, a note, or the
    search box.


WHAT IS UNCHANGED
-----------------
Voice in and out, including the turn-taking, barge-in and six echo-protection
layers in speech.js. The full backend conversation: notes, tasks, Library,
search, summaries. Voice memo recording and upload to Drive. Screen recordings
saved to and replayed from IndexedDB. All five tabs and the settings sheet.
The markup, the element IDs and the stylesheets.


FILES
-----
  index.html      the page (was sidepanel.html)
  sidepanel.css   the stylesheet, unchanged
  tokens.css      the design tokens, unchanged
  sidepanel.js    the orchestrator
  storage.js      the localStorage shim that replaces chrome.storage.local
  speech.js       ears + voice, unchanged
  api.js          the backend transport, unchanged
  config.js       PROXY_URL / API_KEY, unchanged
  ui.js           everything she draws
  notes.js        the Notes view
  nsheet.js       in-page sheets and menus, unchanged
  tabs.js         the bottom tab bar, unchanged
  mode.js         the mode manager, unchanged
  videostore.js   the local screen-recording library (IndexedDB)
  icons/          icon128.png is the page favicon

A note on api.js: it deliberately POSTs "text/plain" with no custom headers.
That is what avoids a CORS preflight your Apps Script backend cannot answer.
Do not change it to application/json and do not add headers.
