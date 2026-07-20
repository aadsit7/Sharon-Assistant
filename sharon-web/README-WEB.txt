Sharon — the web app  (converted from the sharon-extension side panel)
======================================================================

This folder is a plain static site: open index.html from a web server and
Sharon runs at a normal URL, talking to the SAME Google Apps Script backend
(and the same "Speaking Assistant" Google Sheet) as the Chrome extension.


Serve it — never open the file directly
---------------------------------------
The microphone and speech recognition only work in a "secure context":
an https URL (GitHub Pages qualifies) or http://localhost. Opening
index.html by double-clicking it (a file:// address) will block the mic
AND the JavaScript modules — the page will look dead. Always serve it.

To test locally: from inside sharon-web/, run

    python3 -m http.server

and open  http://localhost:8000  in your browser.


The passphrase
--------------
The page is public, so no key is anywhere in these files. On first visit
Sharon shows an unlock screen; whatever you type is stored only in that
browser's localStorage and sent with each request as the api_key. It must
match the Apps Script project's Script Property named API_KEY.

Because anyone can load the page, the passphrase is the ONLY thing keeping
strangers out of your Sheet — make it long and hard to guess. Set it in the
Apps Script project (Sheet → Extensions → Apps Script → Project Settings →
Script Properties → API_KEY), not left as a short value. If the server
rejects the stored passphrase, the unlock screen comes back on its own.


Sections
--------
Named note sections are stored in the memory_log tab's "project" column.
They only save if the backend deployment includes that change (the same
backend/Code.gs the extension uses — deploy a "New version" after pasting,
and make sure memory_log's header row has a column named exactly  project).
If the deployment is older, the Notes view shows a dismissible notice and
everything except saving sections keeps working.


Reminders
---------
- Test over https or http://localhost — never file://.
- The backend and Sheet are shared with the extension; redeploying Code.gs
  updates both.
- Voice memos still upload to Drive through the backend; screen recording,
  page reading and keyboard shortcuts were extension-only features and do
  not exist in the web app.
