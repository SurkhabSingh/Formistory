/**
 * Background — the only context that touches IndexedDB.
 *
 * Chrome runs this as a service worker that terminates after ~30s idle; Firefox
 * runs it as a non-persistent event page. Neither keeps state between messages,
 * so nothing here is cached: every message opens the DB, writes, and returns.
 */
"use strict";

// Chrome's service worker allows exactly one entry file, so it pulls in db.js
// itself. Firefox's event page has no importScripts, and instead gets db.js from
// the manifest's background.scripts array before this file runs.
if (typeof importScripts === "function") importScripts("db.js");

const api = globalThis.browser ?? globalThis.chrome;
const db = globalThis.FA.db;

/**
 * Tell any open extension page that the archive moved.
 *
 * With no viewer or popup open there is no receiver, and the send rejects — that
 * is the normal case, not an error, so it is swallowed deliberately here (unlike
 * in the capture path, where a failed send means lost data).
 */
function broadcast(type) {
  try {
    const p = api.runtime.sendMessage({ type });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    /* no listening context */
  }
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  switch (msg.type) {
    case "submission/put":
      db.put(msg.submission)
        .then(() => {
          sendResponse({ ok: true });
          broadcast("archive/changed");
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep the message channel open for the async reply

    case "submission/list":
      db.all({ limit: msg.limit })
        .then((items) => sendResponse({ ok: true, items }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "submission/stats":
      db.count()
        .then((count) => sendResponse({ ok: true, count }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "submission/delete":
      db.remove(msg.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "submission/clear":
      db.clear()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    default:
      return false;
  }
});
