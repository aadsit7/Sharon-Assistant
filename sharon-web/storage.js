// storage.js — the stand-in for chrome.storage.local on a normal web page.
//
// The extension kept four things in chrome.storage.local: the settings object,
// the first-run setup checklist, the session id, and the Notes sections (names
// + which ones are folded shut). A web page has localStorage instead —
// synchronous, string-only, per-origin, and it survives a reload the same way.
//
// This module wraps it so the ORIGINAL call shapes keep working untouched:
//   • get(keys) takes a string, an array of strings, an object of defaults, or
//     nothing at all (everything), and resolves to an object — exactly like
//     chrome.storage.local.get, so `const { sharon_session_id } = await
//     storage.get("sharon_session_id")` reads the same as it always did.
//   • set(items) / remove(keys) resolve when the write is done.
// Every stored KEY NAME is unchanged.
//
// Values are JSON-encoded on the way in and decoded on the way out, so the
// objects and arrays the panel stores round-trip exactly as they did before
// (localStorage on its own would flatten them to "[object Object]").
//
// Writes never reject. Persisting is best-effort everywhere in the panel — the
// old code swallowed chrome.storage errors at every call site — and a browser
// with storage disabled (private mode, blocked cookies) should degrade to
// "nothing is remembered between visits", not to a crash.

function decode(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw; // not ours / hand-edited — hand it back as the plain string
  }
}

function readInto(out, key, fallback) {
  let value;
  try {
    value = decode(localStorage.getItem(key));
  } catch (_) {
    value = undefined; // storage unavailable — fall through to the default
  }
  if (value !== undefined) out[key] = value;
  else if (fallback !== undefined) out[key] = fallback;
}

/**
 * Read stored values. Mirrors chrome.storage.local.get:
 *   get("k")            → { k }              (absent keys are simply missing)
 *   get(["a","b"])      → { a, b }
 *   get({ a: 1 })       → { a }              (1 is the default when unset)
 *   get()               → everything stored
 */
export function get(keys) {
  const out = {};
  try {
    if (keys == null) {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key != null) readInto(out, key);
      }
    } else if (typeof keys === "string") {
      readInto(out, keys);
    } else if (Array.isArray(keys)) {
      for (const key of keys) readInto(out, String(key));
    } else if (typeof keys === "object") {
      for (const key of Object.keys(keys)) readInto(out, key, keys[key]);
    }
  } catch (_) {
    /* storage is unavailable — callers keep their defaults */
  }
  return Promise.resolve(out);
}

/** Write one or more keys: set({ sharon_settings: {...} }). */
export function set(items) {
  try {
    for (const [key, value] of Object.entries(items || {})) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch (_) {
    /* full or blocked — this visit still works, it just won't be remembered */
  }
  return Promise.resolve();
}

/** Forget one key or a list of them. */
export function remove(keys) {
  try {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) localStorage.removeItem(String(key));
  } catch (_) {
    /* ignore */
  }
  return Promise.resolve();
}
