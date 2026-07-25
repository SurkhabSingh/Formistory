/**
 * Phase 1 stub. Enough to confirm capture is working without opening DevTools;
 * the real document viewer (search, per-submission reading) is Phase 2.
 */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const $count = document.getElementById("count");
const $list = document.getElementById("list");
const $empty = document.getElementById("empty");

const send = (msg) =>
  new Promise((resolve) => api.runtime.sendMessage(msg, (res) => resolve(res || { ok: false })));

function when(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

async function render() {
  const res = await send({ type: "submission/list", limit: 30 });
  if (!res.ok) {
    $count.textContent = "error";
    return;
  }

  const items = res.items || [];
  $count.textContent = items.length ? `${items.length} captured` : "";
  $empty.hidden = items.length > 0;
  $list.replaceChildren();

  for (const s of items) {
    const li = document.createElement("li");
    li.dataset.id = s.id;
    li.style.cursor = "pointer";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.pageTitle || s.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const answered = (s.fields || []).length;
    meta.textContent = `${s.origin} · ${answered} field${answered === 1 ? "" : "s"} · ${when(s.updatedAt)} · `;

    const status = document.createElement("span");
    status.className = "status";
    status.textContent = s.status;
    meta.append(status);

    li.append(title, meta);
    $list.append(li);
  }
}

// Reading happens in the full viewer; the popup is only a glance.
document.getElementById("open").addEventListener("click", () => {
  const url = api.runtime.getURL("viewer.html");
  if (api.tabs && api.tabs.create) api.tabs.create({ url });
  else window.open(url);
  window.close();
});

// Clicking a row opens that form in the viewer.
$list.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const url = `${api.runtime.getURL("viewer.html")}#${encodeURIComponent(li.dataset.id)}`;
  if (api.tabs && api.tabs.create) api.tabs.create({ url });
  else window.open(url);
  window.close();
});

render();
