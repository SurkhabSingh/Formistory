"use strict";

/**
 * Viewer tests. Loads viewer.html into jsdom with a stubbed extension API, runs
 * viewer.js against it, and drives the real UI.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function record(over = {}) {
  return {
    id: "r1", pageTitle: "Backend Engineer — Acme", origin: "https://boards.example.com",
    url: "https://boards.example.com/acme/apply", status: "submitted",
    updatedAt: Date.now(),
    fields: [
      { order: 0, label: "Full name", value: "Ada Lovelace" },
      { order: 1, label: "Why do you want to work here?", value: "The problem is interesting." },
      { order: 2, label: "Social Security Number", value: "", redacted: true, redactReason: "ssn-pattern" },
      { order: 3, label: "", value: "answer with no question" },
    ],
    ...over,
  };
}

function boot(items) {
  const html = fs.readFileSync(path.join(__dirname, "../viewer.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "chrome-extension://abcdef/viewer.html",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const ctx = dom.getInternalVMContext();

  const state = { items: [...items], listeners: [], sent: [] };
  ctx.chrome = {
    runtime: {
      id: "abcdef",
      getURL: (p) => `chrome-extension://abcdef/${p}`,
      onMessage: { addListener: (fn) => state.listeners.push(fn) },
      sendMessage(msg, cb) {
        state.sent.push(msg);
        let res = { ok: true };
        if (msg.type === "submission/list") res = { ok: true, items: state.items };
        if (msg.type === "submission/delete") state.items = state.items.filter((s) => s.id !== msg.id);
        if (msg.type === "submission/clear") state.items = [];
        if (cb) setTimeout(() => cb(res), 0);
        return Promise.resolve(res);
      },
    },
  };

  vm.runInContext(fs.readFileSync(path.join(__dirname, "viewer.js"), "utf8"), ctx, {
    filename: "viewer.js",
  });
  return { dom, doc: dom.window.document, state };
}

const texts = (doc, sel) => [...doc.querySelectorAll(sel)].map((n) => n.textContent);

test("renders real records from the extension, not the sample data", async () => {
  const { dom, doc } = boot([record()]);
  await sleep(30);

  // The preview fallback must never engage inside the extension.
  assert.ok(!doc.body.textContent.includes("preview — sample data"), "sample data shown in-extension");
  assert.ok(!doc.body.textContent.includes("Easy Apply — Platform Engineer"), "demo record leaked");
  assert.ok(doc.body.textContent.includes("live"), "no live indicator");
  assert.deepEqual(texts(doc, ".item h2"), ["Backend Engineer — Acme"]);
  assert.match(doc.getElementById("count").textContent, /1 form/);
  dom.window.close();
});

test("opening a record shows its questions and answers in order", async () => {
  const { dom, doc } = boot([record()]);
  await sleep(30);
  doc.querySelector(".item").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  assert.deepEqual(texts(doc, "#detail dt"), [
    "Full name",
    "Why do you want to work here?",
    "Social Security Number",
    "Unlabelled field 4",
  ]);
  const answers = texts(doc, "#detail dd");
  assert.equal(answers[0], "Ada Lovelace");
  // A refused value must say so rather than look merely blank.
  assert.match(answers[2], /redacted \(ssn-pattern\)/);
  assert.equal(answers[3], "answer with no question");
  dom.window.close();
});

test("a new capture appears without reloading the page", async () => {
  const { dom, doc, state } = boot([record()]);
  await sleep(30);
  assert.equal(doc.querySelectorAll(".item").length, 1);

  // The background writes another record and broadcasts.
  state.items.unshift(record({ id: "r2", pageTitle: "Platform Engineer — Globex" }));
  assert.ok(state.listeners.length, "the viewer never subscribed to updates");
  state.listeners.forEach((fn) => fn({ type: "archive/changed" }));
  await sleep(500); // 400ms coalescing window

  assert.deepEqual(texts(doc, ".item h2"), [
    "Platform Engineer — Globex",
    "Backend Engineer — Acme",
  ]);
  dom.window.close();
});

test("a burst of updates collapses into one reload", async () => {
  const { dom, state } = boot([record()]);
  await sleep(30);
  const before = state.sent.filter((m) => m.type === "submission/list").length;

  // Capture flushes every 800ms while typing; each must not cost a re-read.
  for (let i = 0; i < 10; i++) state.listeners.forEach((fn) => fn({ type: "archive/changed" }));
  await sleep(500);

  const after = state.sent.filter((m) => m.type === "submission/list").length;
  assert.equal(after - before, 1, `expected 1 reload, got ${after - before}`);
  dom.window.close();
});

test("a live update keeps the open record open", async () => {
  const { dom, doc, state } = boot([record()]);
  await sleep(30);
  doc.querySelector(".item").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.match(doc.querySelector("#detail h2").textContent, /Acme/);

  state.items.unshift(record({ id: "r2", pageTitle: "Something Else" }));
  state.listeners.forEach((fn) => fn({ type: "archive/changed" }));
  await sleep(500);

  // Reading must not be interrupted by an unrelated capture.
  assert.match(doc.querySelector("#detail h2").textContent, /Acme/);
  dom.window.close();
});

test("search filters and highlights, and clears cleanly", async () => {
  const { dom, doc } = boot([record(), record({ id: "r2", pageTitle: "Globex", fields: [
    { order: 0, label: "Languages", value: "Rust and TypeScript" },
  ] })]);
  await sleep(30);

  const q = doc.getElementById("q");
  q.value = "rust";
  q.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(texts(doc, ".item h2"), ["Globex"]);
  assert.match(doc.getElementById("count").textContent, /1 of 2/);

  q.value = "";
  q.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(doc.querySelectorAll(".item").length, 2);
  dom.window.close();
});

test("captured text is never treated as markup", async () => {
  const nasty = record({
    pageTitle: "<img src=x onerror=alert(1)>",
    fields: [{ order: 0, label: "<b>bold?</b>", value: "<script>alert(2)</script>" }],
  });
  const { dom, doc } = boot([nasty]);
  await sleep(30);
  doc.querySelector(".item").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  // Content comes from arbitrary websites; it must render as text, always.
  assert.equal(doc.querySelectorAll("#detail script, #detail img, #detail b").length, 0);
  assert.equal(doc.querySelector("#detail dt").textContent, "<b>bold?</b>");
  assert.equal(doc.querySelector("#detail dd").textContent, "<script>alert(2)</script>");
  dom.window.close();
});
