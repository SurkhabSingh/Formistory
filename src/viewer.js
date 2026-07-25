/**
 * The archive viewer — reading back what you wrote.
 *
 * A submission is presented as a document (question, then answer, in the order
 * the form asked) rather than as a table of field values. That is the whole
 * premise of the project, so the UI has to honour it.
 *
 * Everything is rendered with DOM APIs and textContent, never innerHTML: the
 * content here is arbitrary text captured from arbitrary websites, and it must
 * never be interpreted as markup.
 */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const $list = document.getElementById("list");
const $detail = document.getElementById("detail");
const $count = document.getElementById("count");
const $q = document.getElementById("q");

let all = [];
let selectedId = null;
let loadError = null;

// Promise form on both browsers. Chrome MV3 and Firefox both return a promise
// from sendMessage; a rejection here means the background never answered, which
// must not be mistaken for an empty archive.
const send = (msg) =>
  Promise.resolve()
    .then(() => api.runtime.sendMessage(msg))
    .then((res) => res || { ok: false, error: "no response from the background" })
    .catch((err) => ({ ok: false, error: String(err && err.message ? err.message : err) }));

/* ---------- formatting ---------- */

const fmtDay = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
};

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/* ---------- search ---------- */

function matches(sub, needle) {
  if (!needle) return true;
  const haystack = [
    sub.pageTitle || "",
    sub.origin || "",
    sub.url || "",
    ...(sub.fields || []).flatMap((f) => [f.label, f.value]),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Append text to `parent`, wrapping occurrences of `needle` in <mark>. */
function appendHighlighted(parent, text, needle) {
  if (!needle) {
    parent.append(text);
    return;
  }
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    parent.append(text.slice(from, at));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + needle.length);
    parent.append(mark);
    from = at + needle.length;
  }
  parent.append(text.slice(from));
}

/* ---------- rendering ---------- */

function renderList() {
  const needle = $q.value.trim().toLowerCase();
  const shown = all.filter((s) => matches(s, needle));
  // Live refreshes must not yank the list out from under someone reading it.
  const scroll = $list.scrollTop;

  $count.textContent = needle
    ? `${shown.length} of ${all.length}`
    : `${all.length} form${all.length === 1 ? "" : "s"}`;

  $list.replaceChildren();

  if (loadError) {
    const err = document.createElement("div");
    err.className = "empty-state";
    err.append("Could not read the archive. Your data is not lost — the extension's background did not respond. Try reloading this page, or the extension.");
    const detail = document.createElement("div");
    detail.style.marginTop = "8px";
    detail.style.fontSize = "12px";
    detail.textContent = loadError;
    err.append(detail);
    $list.append(err);
    return;
  }

  if (!all.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append("Nothing captured yet. Fill in a form and it will appear here.");
    $list.append(empty);
    return;
  }
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append(`No form mentions “${$q.value.trim()}”.`);
    $list.append(empty);
    return;
  }

  let lastDay = null;
  for (const sub of shown) {
    const day = fmtDay(sub.updatedAt);
    if (day !== lastDay) {
      lastDay = day;
      const h = document.createElement("div");
      h.className = "day";
      h.textContent = day;
      $list.append(h);
    }

    const item = document.createElement("div");
    item.className = "item";
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("aria-selected", String(sub.id === selectedId));

    const h2 = document.createElement("h2");
    h2.textContent = sub.pageTitle || sub.origin || "Untitled form";
    item.append(h2);

    const meta = document.createElement("div");
    meta.className = "meta";
    const answered = (sub.fields || []).length;
    meta.append(`${fmtTime(sub.updatedAt)} · ${answered} answer${answered === 1 ? "" : "s"}`);
    if (sub.status !== "draft") {
      const badge = document.createElement("span");
      badge.className = `badge ${sub.status}`;
      badge.textContent = sub.status;
      meta.append(badge);
    }
    item.append(meta);

    const open = () => {
      selectedId = sub.id;
      renderList();
      renderDetail(sub);
    };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    $list.append(item);
  }

  $list.scrollTop = scroll;
}

function renderDetail(sub) {
  const needle = $q.value.trim().toLowerCase();
  $detail.replaceChildren();

  const h2 = document.createElement("h2");
  h2.textContent = sub.pageTitle || sub.origin || "Untitled form";
  $detail.append(h2);

  const sub2 = document.createElement("p");
  sub2.className = "sub";
  const when = new Date(sub.updatedAt).toLocaleString();
  sub2.append(`${when} · ${sub.status} · `);
  // Only ever link out over http(s). Everything else — javascript:, data: — is
  // shown as plain text: this is the one place captured content could become an
  // executable URL inside the extension's own origin.
  const safeHref = /^https?:\/\//i.test(sub.url || "");
  const a = document.createElement(safeHref ? "a" : "span");
  if (safeHref) {
    a.href = sub.url;
    a.target = "_blank";
    a.rel = "noreferrer";
  }
  a.textContent = sub.url;
  sub2.append(a);
  $detail.append(sub2);

  if (!sub.fields || !sub.fields.length) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "This record has no answers.";
    $detail.append(p);
  } else {
    const dl = document.createElement("dl");
    dl.className = "qa";
    for (const f of sub.fields) {
      const dt = document.createElement("dt");
      if (f.label) {
        appendHighlighted(dt, f.label, needle);
      } else {
        // An unlabelled field still kept its answer — say so rather than pretend.
        dt.className = "unlabelled";
        dt.textContent = `Unlabelled field ${f.order + 1}`;
      }
      dl.append(dt);

      const dd = document.createElement("dd");
      if (f.redacted) {
        dd.className = "redacted";
        dd.textContent = `redacted (${f.redactReason || "sensitive"}) — the answer was deliberately not stored`;
      } else if (f.value === "" && !(f.options && f.options.length)) {
        // Strict empty check: a stored "0" (a number, a spinbutton) is a real
        // answer, not a blank one.
        dd.className = "empty";
        dd.textContent = "(left blank)";
      } else {
        appendHighlighted(dd, f.value, needle);
      }
      dl.append(dd);
    }
    $detail.append(dl);
  }

  const del = document.createElement("button");
  del.className = "danger";
  del.textContent = "Delete this form";
  del.addEventListener("click", async () => {
    if (!confirm("Delete this record? This cannot be undone.")) return;
    await send({ type: "submission/delete", id: sub.id });
    selectedId = null;
    $detail.replaceChildren(Object.assign(document.createElement("p"), {
      className: "placeholder",
      textContent: "Deleted.",
    }));
    await load();
  });
  $detail.append(del);
}

/* ---------- actions ---------- */

async function load() {
  const res = await send({ type: "submission/list", limit: 1000 });
  if (!res.ok) {
    // Never render "nothing captured yet" for a failure — that tells someone
    // their archive is gone when the background merely did not answer.
    loadError = res.error || "unknown error";
    all = [];
    renderList();
    return;
  }
  loadError = null;
  all = res.items || [];

  // Opened from the popup with a specific record in mind.
  if (!selectedId && location.hash.length > 1) {
    try {
      selectedId = decodeURIComponent(location.hash.slice(1));
    } catch {
      selectedId = location.hash.slice(1); // malformed escape — use it verbatim
    }
  }
  renderList();
  const chosen = all.find((s) => s.id === selectedId);
  if (chosen) renderDetail(chosen);
}

$q.addEventListener("input", () => {
  renderList();
  const still = all.find((s) => s.id === selectedId);
  if (still) renderDetail(still);
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm(`Delete all ${all.length} captured forms? This cannot be undone.`)) return;
  await send({ type: "submission/clear" });
  selectedId = null;
  $detail.replaceChildren();
  await load();
});

document.getElementById("export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `formistory-${new Date().toISOString().slice(0, 10)}.json`;
  // Firefox needs the anchor in the document, and revoking synchronously after
  // click() cancels the download before it starts.
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
});

/* ---------- live updates ---------- */

let refreshTimer = null;

/**
 * Coalesce bursts. Capture flushes on an 800ms debounce while you type, so a
 * long answer would otherwise re-render the list on every pause.
 */
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load();
  }, 400);
}

api.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "archive/changed") scheduleRefresh();
});
// Belt and braces: a broadcast can be missed if this page was backgrounded when
// the service worker fired it, so re-read whenever the tab comes forward.
window.addEventListener("focus", scheduleRefresh);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") scheduleRefresh();
});

const live = document.createElement("span");
live.className = "count";
live.textContent = "· live";
live.title = "Updates as you fill in forms";
document.querySelector("header").insertBefore(live, $q);

load();
