// config.js — single source of truth for Sharon's backend (web app).
//
// Sharon never contains the AI provider key. She POSTs an action envelope to
// this Google Apps Script web app ("Speaking_Assistant"), which checks the
// shared API_KEY, adds the secret ANTHROPIC_API_KEY, calls the model with
// tools, and reads/writes the Google Sheet database for her.
//
// Because this page is PUBLIC, the shared key is NEVER written in this file.
// The visitor types their passphrase once (the unlock overlay in app.js); it
// is kept only in their own browser's localStorage and read fresh on every
// request via getApiKey() below. It must match the Script Property named
// API_KEY in the Apps Script project.
export const PROXY_URL = "https://script.google.com/macros/s/AKfycbwzjjbdykzzh60zIfPBvU6RA02RzMjvxbVnwW8OC4zTAxOmgivofmHq9xCDLliVxXZiog/exec";
export function getApiKey() { return localStorage.getItem("sharon_api_key") || ""; }

// Real rows in the Sheet, so Sharon's memory recall matches your data.
// Sent on EVERY backend call. If blank, memory recall won't match.
export const USER_ID = "usr_aaron"; // row in the "users" tab
export const ASSISTANT_ID = "asst_sharon"; // row in the "assistants" tab (this is Sharon)

// How much page text rides along with each request. Smaller = faster + cheaper;
// this is plenty for the model to read/answer about what's visible.
export const PAGE_EXCERPT_CHARS = 16000;

// How many recent conversational turns Sharon carries as context so she can
// actually hold a conversation ("what did I just ask you?", follow-ups, "it").
export const HISTORY_TURNS = 12;

export const EXTENSION_VERSION = "7.5.0";
