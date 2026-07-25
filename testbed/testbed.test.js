"use strict";

/**
 * Assertions for the offline testbed pages.
 *
 * Each page states in its own markup what should be captured; this file holds the
 * machine-checkable version of those claims, so a regression shows up in `npm test`
 * rather than only under manual inspection.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

globalThis.__FORM_SPIKE_NO_AUTORUN = true;
const resolver = require("../src/field-identity.js");
const collect = require("../src/collect.js");

const NOW = 1_700_000_000_000;
const OPTS = { checkVisibility: false }; // jsdom has no layout engine
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function load(page) {
  const html = fs.readFileSync(path.join(__dirname, page), "utf8");
  return new JSDOM(html, {
    url: `https://testbed.local/${page}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
}

/** Walk a document the way capture.js does and build one submission. */
function capture(dom, doc = dom.window.document) {
  const draft = collect.createDraft({
    id: "t",
    scopeKey: "page",
    url: dom.window.location.href,
    origin: dom.window.location.origin,
    pathNormalized: resolver.normalizePath(dom.window.location.pathname),
    title: doc.title,
    now: NOW,
  });
  let id = 0;
  for (const el of walk(doc)) {
    if (resolver.isExcluded(el)) continue;
    collect.upsertField(draft, resolver.describeField(el), collect.readValue(el), ++id, NOW);
  }
  return collect.toSubmission(draft, "submitted", NOW);
}

/** querySelectorAll that also descends into open shadow roots. */
function* walk(root) {
  for (const el of root.querySelectorAll("*")) {
    if (el.matches(resolver.FIELD_SELECTOR)) yield el;
    if (el.shadowRoot) yield* walk(el.shadowRoot);
  }
}

const labelsOf = (sub) => sub.fields.map((f) => f.label);
const answers = (sub) => Object.fromEntries(sub.fields.map((f) => [f.label, f.value]));

/**
 * Give every text-ish control a value. Empty fields are dropped from a submission
 * by design, so a test that asserts on labels has to fill them first.
 */
function fillAll(doc, value = "answer") {
  for (const el of walk(doc)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && /^(text|email|url|tel|number|search|date|time)$/.test(el.type || "text")) {
      if (!el.value) el.value = el.type === "number" ? "1" : value;
    } else if (tag === "textarea") {
      if (!el.value) el.value = value;
    } else if (el.hasAttribute("contenteditable")) {
      if (!el.textContent) el.textContent = value;
    }
  }
}

/* ---------------------------------------------------------------- 01 */

test("01 classic: every native control resolves, choice group collapses", () => {
  const dom = load("01-classic.html");
  const doc = dom.window.document;

  doc.getElementById("name").value = "Ada Lovelace";
  doc.getElementById("why").value = "The problem is interesting.";
  doc.querySelector('input[value="Contract"]').checked = true;
  doc.getElementById("relocate")?.setAttribute("checked", "checked");
  doc.querySelector('input[name="relocate"]').checked = true;
  doc.getElementById("level").value = "Senior";

  const sub = capture(dom);
  const a = answers(sub);

  assert.equal(a["Full name"], "Ada Lovelace");
  assert.equal(a["Why do you want to work here?"], "The problem is interesting.");
  assert.equal(a["Seniority"], "Senior");
  // One field for the group, not one per radio.
  assert.equal(a["Employment type"], "Contract");
  assert.equal(labelsOf(sub).filter((l) => l === "Employment type").length, 1);
  // A lone checkbox is a yes/no answer to its own label.
  assert.equal(a["Willing to relocate"], "Yes");
  assert.ok(!JSON.stringify(sub).includes("should-never-be-captured"), "hidden token captured");
  dom.window.close();
});

/* ---------------------------------------------------------------- 02 */

test("02 no-form SPA: captured despite no form element and UUID identifiers", () => {
  const dom = load("02-no-form-spa.html");
  const doc = dom.window.document;
  fillAll(doc);
  doc.querySelector("#app input").value = "Ada";

  const sub = capture(dom);
  const labels = labelsOf(sub);

  assert.ok(labels.includes("Legal name"));
  // label[for] points at a non-existent id and the input has no id: only the
  // container text can rescue it, and the generic placeholder must be refused.
  assert.ok(
    labels.includes("Where do you plan on working from?"),
    `location question lost; got ${JSON.stringify(labels)}`
  );
  assert.ok(!labels.some((l) => /^(Type here|Start typing)/.test(l)), "generic placeholder used as label");
  dom.window.close();
});

/* ---------------------------------------------------------------- 03 */

test("03 aria widgets: div-based choices are captured and grouped by question", () => {
  const dom = load("03-aria-widgets.html");
  const doc = dom.window.document;

  doc.querySelector('[data-value="I have shipped them"]').setAttribute("aria-checked", "true");
  doc.querySelector('[aria-label="Rust"]').setAttribute("aria-checked", "true");
  doc.querySelector('[aria-label="Go"]').setAttribute("aria-checked", "true");

  const sub = capture(dom);
  const a = answers(sub);

  // Not one native radio or checkbox exists on that page.
  assert.equal(a["How familiar are you with distributed systems?"], "I have shipped them");
  assert.equal(a["Which languages would you use day to day?"], "Rust, Go");
  dom.window.close();
});

/* ---------------------------------------------------------------- 04 */

test("04 shadow DOM: open roots captured at any depth, closed root invisible", () => {
  const dom = load("04-shadow-dom.html");
  const doc = dom.window.document;
  fillAll(doc);
  const labels = labelsOf(capture(dom, doc));

  assert.ok(labels.includes("Light DOM field"));
  assert.ok(labels.includes("Field inside an open shadow root"));
  assert.ok(labels.includes("Field two shadow roots deep"), "nested open shadow root missed");
  // Not a bug — closed roots are unreachable by any extension. Pinned so the
  // limitation stays documented rather than being rediscovered later.
  assert.ok(
    !labels.includes("Field inside a CLOSED shadow root"),
    "a closed shadow root should be unreachable"
  );
  dom.window.close();
});

/* ---------------------------------------------------------------- 05 */

test("05 wizard: three steps produce ONE document, not one per step", async () => {
  const dom = load("05-multi-step-wizard.html");
  const ctx = dom.getInternalVMContext();
  const sent = [];
  ctx.chrome = {
    runtime: { id: "test", sendMessage: (m) => (sent.push(m), Promise.resolve({ ok: true })) },
  };
  for (const f of ["field-identity.js", "redact.js", "collect.js", "capture.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", f), "utf8"), ctx, { filename: f });
  }

  const doc = dom.window.document;
  const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  // Step 1
  doc.getElementById("w-name").value = "Ada Lovelace";
  fire(doc.getElementById("w-name"), "input");
  doc.getElementById("w-email").value = "ada@example.com";
  fire(doc.getElementById("w-email"), "input");
  click(doc.getElementById("next"));
  await sleep(60);

  // Step 2 — the <form> node has been replaced by now
  doc.getElementById("w-exp").value = "12";
  fire(doc.getElementById("w-exp"), "input");
  const yes = doc.querySelector('input[name="w-auth"][value="Yes"]');
  yes.checked = true;
  fire(yes, "change");
  click(doc.getElementById("next"));
  await sleep(60);

  // Step 3
  doc.getElementById("w-why").value = "Because the work matters.";
  fire(doc.getElementById("w-why"), "input");
  click(doc.getElementById("submit"));
  await sleep(60);

  const finals = sent.filter((m) => m.submission.status === "submitted");
  assert.equal(finals.length, 1, `expected exactly one finalised document, got ${finals.length}`);

  const a = answers(finals[0].submission);
  // Everything from step 1 must have survived to the end.
  assert.equal(a["Full name"], "Ada Lovelace");
  assert.equal(a["Email"], "ada@example.com");
  assert.equal(a["Years of experience"], "12");
  assert.equal(a["Are you legally authorized to work?"], "Yes");
  assert.equal(a["Why this role?"], "Because the work matters.");
  dom.window.close();
});

/* ---------------------------------------------------------------- 07 */

test("07 sensitive: excluded fields absent, risky values redacted, questions kept", () => {
  const dom = load("07-sensitive.html");
  const sub = capture(dom);
  const a = answers(sub);
  const raw = JSON.stringify(sub);

  // Never stored at all. ("123", the CVV, is deliberately not substring-checked —
  // it also occurs inside the employee number, which is correctly kept.)
  for (const leak of ["hunter2", "4111 1111 1111 1111", "482913", "tok-should-never-appear", "bot-token-should-never-appear"]) {
    assert.ok(!raw.includes(leak), `excluded value leaked: ${leak}`);
  }
  // The excluded fields must be absent entirely, not merely emptied.
  for (const gone of [
    "Password",
    "Card number (autocomplete=cc-number)",
    "Security code (autocomplete=cc-csc)",
    "One-time code",
  ]) {
    assert.equal(a[gone], undefined, `"${gone}" should never be captured`);
  }

  // Stored, but redacted — with the question intact.
  assert.equal(a["Social Security Number"], "[redacted]");
  assert.equal(a["Payment card (plain text box, no autocomplete hint)"], "[redacted]");
  assert.equal(a["Date of birth"], "[redacted]");
  assert.equal(a["Passport number"], "[redacted]");

  // False-positive guard: over-redacting destroys the answers this tool exists to keep.
  assert.equal(a["Order reference (16 digits, fails Luhn)"], "4111111111111112");
  assert.equal(a["Employee number (9 digits)"], "123456789");

  // Ordinary answers untouched.
  assert.equal(a["Full name"], "Ada Lovelace");
  dom.window.close();
});

/* ---------------------------------------------------------------- 08 */

test("08 dynamic: late-mounted, conditional and repeated fields are all captured", async () => {
  const dom = load("08-dynamic.html");
  const doc = dom.window.document;

  await sleep(1700); // the page injects a field at 1.5s

  const yes = doc.querySelector('input[name="d-visa"][value="Yes"]');
  yes.checked = true;
  yes.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  doc.getElementById("add-row").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  doc.getElementById("d-late").value = "late value";
  doc.getElementById("d-visa-type").value = "H-1B";
  doc.getElementById("d-emp-1").value = "Acme";

  const a = answers(capture(dom));
  assert.equal(a["Field injected 1.5s after load"], "late value");
  assert.equal(a["Which visa do you hold?"], "H-1B");
  assert.equal(a["Employer 1"], "Acme");
  assert.equal(a["Do you require visa sponsorship?"], "Yes");
  dom.window.close();
});

/* ---------------------------------------------------------------- 09 */

test("09 custom widgets: mirrored values and rich text are captured", () => {
  const dom = load("09-custom-widgets.html");
  const doc = dom.window.document;

  doc.getElementById("w-combo").value = "India";
  doc.getElementById("rs-value").value = "TypeScript, Rust";
  doc.getElementById("w-rich").textContent = "Dear hiring manager,";

  const a = answers(capture(dom));
  assert.equal(a["Country (role=combobox on a native input)"], "India");
  assert.equal(a["Selected skills"], "TypeScript, Rust");
  assert.equal(a["Cover letter (contenteditable rich text)"], "Dear hiring manager,");
  dom.window.close();
});

/* ---------------------------------------------------------------- 10 */

test("10 hostile: degrades without ever producing a confidently wrong label", () => {
  const dom = load("10-hostile.html");
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll('input[type="text"]')) el.value = "answer";

  const sub = capture(dom);
  const byName = Object.fromEntries(sub.fields.map((f) => [f.name, f]));

  // The killer case: an unlabelled field must not inherit the previous question.
  assert.notEqual(byName["h-orphan"].label, "A question in a plain div");
  assert.ok(byName["h-orphan"].confidence < resolver.READABLE_THRESHOLD);

  // CSS must never be read as a label.
  for (const f of sub.fields) {
    assert.ok(!/\{|opacity:|position:absolute/.test(f.label), `CSS leaked: "${f.label}"`);
  }

  // Generic placeholders refused; a real one accepted.
  for (const n of ["h-ph1", "h-ph2", "h-ph3", "h-ph4", "h-ph5"]) {
    assert.notEqual(byName[n].labelSource, "PLACEHOLDER", `generic placeholder used for ${n}`);
  }
  assert.equal(byName["h-ph-good"].label, "LinkedIn URL");

  // An icon-only label is not a label.
  assert.ok(byName["h-icon"].confidence < resolver.READABLE_THRESHOLD);

  // Worst case still keeps the answer, just unlabelled.
  const anonymous = sub.fields.find((f) => !f.name && !f.domId);
  assert.ok(anonymous, "a field with no identifiers at all should still be stored");
  assert.equal(anonymous.value, "answer");
  dom.window.close();
});

test("10 hostile: unchecking one option does not delete the other's answer", () => {
  const dom = load("10-hostile.html");
  const doc = dom.window.document;
  const [a, b] = doc.querySelectorAll('input[name="h-pick"]');

  const draft = collect.createDraft({ id: "t", scopeKey: "page", url: "https://x/", origin: "https://x", pathNormalized: "/", title: "", now: NOW });
  a.checked = true;
  collect.upsertField(draft, resolver.describeField(a), collect.readValue(a), 1, NOW);
  collect.upsertField(draft, resolver.describeField(b), collect.readValue(b), 2, NOW);

  assert.equal(Object.values(draft.fields)[0].value, "A", "the unchecked sibling wiped the answer");
  dom.window.close();
});
