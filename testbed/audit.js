"use strict";

/**
 * Gap audit. Deliberately NOT an assertion file.
 *
 * testbed.test.js checks the things I already thought of; this walks every page
 * and reports what is actually present versus what survives capture, so the
 * omissions I did not think to assert show up on their own.
 *
 *   node testbed/audit.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

globalThis.__FORM_SPIKE_NO_AUTORUN = true;
const resolver = require("../src/field-identity.js");
const collect = require("../src/collect.js");

const NOW = 1_700_000_000_000;
// Anything a person can put a value into, whether or not we intend to capture it.
const INTERACTIVE = "input, textarea, select, [contenteditable=''], [contenteditable='true'], " +
  "[role=radio], [role=checkbox], [role=switch], [role=textbox], [role=combobox], [role=listbox], " +
  "[role=spinbutton], [role=slider]";
const NON_FIELD_TYPES = new Set(["submit", "button", "reset", "image"]);

function* walk(root) {
  for (const el of root.querySelectorAll("*")) {
    if (el.matches(INTERACTIVE)) yield el;
    if (el.shadowRoot) yield* walk(el.shadowRoot);
  }
}

function describe(el) {
  const tag = el.tagName.toLowerCase();
  const type = resolver.fieldType(el);
  const id = el.getAttribute("name") || el.getAttribute("id") || `<${tag} ${type}>`;
  return { el, tag, type, id };
}

function audit(page) {
  const html = fs.readFileSync(path.join(__dirname, page), "utf8");
  const dom = new JSDOM(html, {
    url: `https://testbed.local/${page}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const doc = dom.window.document;

  // Fill everything a person could fill, so nothing is dropped merely for being empty.
  for (const el of walk(doc)) {
    const t = resolver.fieldType(el);
    if (NON_FIELD_TYPES.has(t)) continue;
    if (t === "radio" || t === "checkbox" || t === "switch") {
      if (typeof el.checked === "boolean") el.checked = true;
      else el.setAttribute("aria-checked", "true");
    } else if (el.tagName.toLowerCase() === "select") {
      if (el.options.length > 1) el.selectedIndex = 1;
    } else if (el.hasAttribute("contenteditable")) {
      if (!el.textContent) el.textContent = "audit";
    } else if (t === "file") {
      // A file input's value cannot be assigned; capture reads el.files instead.
      const F = dom.window.File;
      Object.defineProperty(el, "files", { value: [new F(["x"], "audit.pdf")], configurable: true });
    } else if ("value" in el && !el.value) {
      // Typed inputs reject arbitrary strings, so each needs a valid shape or it
      // stays empty and shows up as a false gap.
      const seed = { number: "1", range: "50", date: "2026-01-01", time: "12:30", color: "#112233", email: "a@b.co", url: "https://a.co" };
      try { el.value = seed[t] || "audit"; } catch {}
    }
  }

  const present = [...walk(doc)].map(describe).filter((f) => !NON_FIELD_TYPES.has(f.type));

  const draft = collect.createDraft({
    id: "audit", scopeKey: "page", url: dom.window.location.href,
    origin: dom.window.location.origin, pathNormalized: "/", title: doc.title, now: NOW,
  });
  // Classify up front. "excluded" (passwords, bot tokens), "passenger" (volume,
  // colour, toggle) and "search" are deliberate drops, not silent gaps — only a
  // dropped "text"/"choice" answer is a real problem.
  const excluded = [];
  const passengers = [];
  let seq = 0;
  for (const f of present) {
    const kind = resolver.classify(f.el);
    f.kind = kind;
    if (kind === "excluded") { excluded.push(f); continue; }
    if (kind === "passenger" || kind === "search") { passengers.push(f); continue; }
    collect.upsertField(draft, resolver.describeField(f.el), collect.readValue(f.el), ++seq, NOW);
  }
  const sub = collect.toSubmission(draft, "submitted", NOW);

  // Which armed (data) controls left no trace in the document?
  const capturedIds = new Set();
  for (const f of present) {
    if (f.kind !== "text" && f.kind !== "choice") continue;
    const r = resolver.describeField(f.el);
    const key = collect.fieldKey(r, "?");
    if (sub.fields.some((sf) => (sf.key.startsWith("g:") ? sf.key === key : sf.label === r.label))) {
      capturedIds.add(f.id);
    }
  }

  const weak = sub.fields.filter((f) => f.confidence < resolver.READABLE_THRESHOLD);
  const dropped = present.filter(
    (f) => (f.kind === "text" || f.kind === "choice") && !capturedIds.has(f.id)
  );

  dom.window.close();
  return { page, present, excluded, passengers, dropped, weak, sub };
}

const PAGES = fs
  .readdirSync(__dirname)
  .filter((f) => /^\d\d-.*\.html$/.test(f) && f !== "06-inner.html")
  .sort();

let totalWeak = 0;
let totalDropped = 0;

for (const page of PAGES) {
  const r = audit(page);
  totalWeak += r.weak.length;
  totalDropped += r.dropped.length;

  console.log(`\n${"=".repeat(70)}\n${r.page}`);
  console.log(
    `  present ${r.present.length}   captured ${r.sub.fields.length}   ` +
      `excluded ${r.excluded.length}   passenger/search ${r.passengers.length}   ` +
      `unaccounted ${r.dropped.length}   weak ${r.weak.length}`
  );

  if (r.excluded.length) {
    console.log(`  excluded by policy:`);
    for (const f of r.excluded) console.log(`    - ${f.id}  (${f.type})`);
  }
  if (r.passengers.length) {
    console.log(`  passenger/search (stored only if the scope is a form, never counts):`);
    for (const f of r.passengers) console.log(`    - ${f.id}  (${f.type}, ${f.kind})`);
  }
  if (r.dropped.length) {
    console.log(`  !! UNACCOUNTED (present, not excluded, not in the document):`);
    for (const f of r.dropped) console.log(`    - ${f.id}  (${f.type})`);
  }
  if (r.weak.length) {
    console.log(`  ?  weak labels (stored, but no readable question):`);
    for (const f of r.weak) console.log(`    - ${f.name || f.key}  [${f.labelSource}] "${f.label}"`);
  }
}

console.log(`\n${"=".repeat(70)}`);
console.log(`TOTAL unaccounted: ${totalDropped}   weak labels: ${totalWeak}`);
