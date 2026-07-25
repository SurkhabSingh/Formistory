"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

globalThis.__FORM_SPIKE_NO_AUTORUN = true;
const resolver = require("./field-identity.js");
const collect = require("./collect.js");

const NOW = 1_700_000_000_000;

function newDraft(dom, scopeKey = "page") {
  return collect.createDraft({
    id: "test-draft",
    scopeKey,
    url: dom.window.location.href,
    origin: dom.window.location.origin,
    pathNormalized: resolver.normalizePath(dom.window.location.pathname),
    title: dom.window.document.title,
    now: NOW,
  });
}

/** Walk a document the way capture.js does and build one submission. */
function buildSubmission(dom, status = "submitted") {
  const doc = dom.window.document;
  const draft = newDraft(dom);
  let id = 0;
  for (const el of doc.querySelectorAll(resolver.FIELD_SELECTOR)) {
    if (resolver.isExcluded(el)) continue;
    collect.upsertField(draft, resolver.describeField(el), collect.readValue(el), ++id, NOW);
  }
  const fields = Object.values(draft.fields).map((f) => ({ label: f.label, confidence: f.confidence }));
  draft.formSignature = resolver.computeSignature(fields, dom.window.location);
  return collect.toSubmission(draft, status, NOW);
}

/* ---------- value reading ---------- */

test("reads values from every control kind", () => {
  const dom = new JSDOM(
    `<body>
       <label>Name <input name="n" value="Ada"></label>
       <label>Bio <textarea name="b">Hello there</textarea></label>
       <label for="s">Size</label>
       <select id="s"><option>Small</option><option selected>Large</option></select>
       <label>Subscribe <input type="checkbox" name="sub" value="Yes" checked></label>
       <div aria-label="Consent" role="checkbox" aria-checked="true"></div>
       <div contenteditable="true" aria-label="Notes">Some notes</div>
     </body>`,
    { url: "https://x.com/f" }
  );
  const d = dom.window.document;
  const byName = (n) => d.querySelector(`[name="${n}"]`);

  assert.equal(collect.readValue(byName("n")), "Ada");
  assert.equal(collect.readValue(byName("b")), "Hello there");
  assert.equal(collect.readValue(d.querySelector("select")), "Large");
  assert.equal(collect.readValue(byName("sub")), true);
  assert.equal(collect.readValue(d.querySelector('[role=checkbox]')), true);
  assert.equal(collect.readValue(d.querySelector("[contenteditable]")), "Some notes");
});

test("an unchecked choice reads false and stores nothing", () => {
  const dom = new JSDOM(
    `<body><fieldset><legend>Authorized?</legend>
       <label><input type="radio" name="a" value="Yes"></label>
       <label><input type="radio" name="a" value="No"></label>
     </fieldset></body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);
  assert.equal(sub.fields.length, 0, "nothing was selected, so nothing should be stored");
});

/* ---------- document assembly ---------- */

test("a choice group collapses into one field labelled by its question", () => {
  const dom = new JSDOM(
    `<body><fieldset><legend>Work authorization</legend>
       <label><input type="radio" name="a" value="Yes" checked></label>
       <label><input type="radio" name="a" value="No"></label>
     </fieldset></body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);

  // The whole point of submission-as-document: one question, one answer — not
  // two rows reading "Yes: on" and "No: off".
  assert.equal(sub.fields.length, 1);
  assert.equal(sub.fields[0].label, "Work authorization");
  assert.equal(sub.fields[0].value, "Yes");
});

test("a multi-select checkbox group keeps every chosen option in one field", () => {
  const dom = new JSDOM(
    `<body><fieldset><legend>Courses</legend>
       <label><input type="checkbox" name="c" value="Math 1a" checked></label>
       <label><input type="checkbox" name="c" value="Math 1b"></label>
       <label><input type="checkbox" name="c" value="Math 21a" checked></label>
     </fieldset></body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);
  assert.equal(sub.fields.length, 1);
  assert.equal(sub.fields[0].value, "Math 1a, Math 21a");
});

test("unchecking removes an option without dropping the field", () => {
  const dom = new JSDOM(
    `<body><fieldset><legend>Courses</legend>
       <label><input type="checkbox" name="c" value="Math 1a" checked></label>
     </fieldset></body>`,
    { url: "https://x.com/f" }
  );
  const box = dom.window.document.querySelector("input");
  const draft = newDraft(dom);
  const record = resolver.describeField(box);

  collect.upsertField(draft, record, true, 1, NOW);
  assert.equal(Object.values(draft.fields)[0].value, "Math 1a");

  box.checked = false;
  collect.upsertField(draft, record, collect.readValue(box), 1, NOW);
  assert.equal(Object.values(draft.fields)[0].value, "");
});

test("sensitive values are redacted but the question survives", () => {
  const dom = new JSDOM(
    `<body><label>Social Security Number <input name="ssn" value="123-45-6789"></label></body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);

  // Losing "you were asked for an SSN here" would be worse than losing the digits.
  assert.equal(sub.fields.length, 1);
  assert.equal(sub.fields[0].label, "Social Security Number");
  assert.equal(sub.fields[0].value, "[redacted]");
  assert.equal(sub.fields[0].redacted, true);
});

test("password and payment fields never reach the document at all", () => {
  const dom = new JSDOM(
    `<body>
       <label>Email <input name="email" value="a@b.com"></label>
       <label>Password <input type="password" name="pw" value="hunter2"></label>
       <label>Card <input name="card" autocomplete="cc-number" value="4111111111111111"></label>
       <input type="hidden" name="csrf" value="tok">
     </body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);
  const serialized = JSON.stringify(sub);

  assert.equal(sub.fields.length, 1);
  assert.equal(sub.fields[0].label, "Email");
  assert.ok(!serialized.includes("hunter2"), "password value leaked into the document");
  assert.ok(!serialized.includes("4111111111111111"), "card value leaked into the document");
  assert.ok(!serialized.includes("tok"), "hidden token leaked into the document");
});

test("empty fields are dropped and the rest are renumbered", () => {
  const dom = new JSDOM(
    `<body>
       <label>First <input name="a" value="filled"></label>
       <label>Second <input name="b" value=""></label>
       <label>Third <input name="c" value="also filled"></label>
     </body>`,
    { url: "https://x.com/f" }
  );
  const sub = buildSubmission(dom);
  assert.deepEqual(sub.fields.map((f) => f.label), ["First", "Third"]);
  assert.deepEqual(sub.fields.map((f) => f.order), [0, 1]);
});

/* ---------- end to end against a captured real form ---------- */

test("a real Lever application becomes a readable document", () => {
  const html = fs.readFileSync(path.join(__dirname, "../spike/samples/lever-whoop.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://jobs.lever.co/whoop/2b8ea4e2-e585-4e46-9e6c-6eefead4f437/apply",
  });
  const d = dom.window.document;

  // Fill it in the way a person would.
  d.querySelector('input[name="name"], input[name="fullName"]')?.setAttribute("value", "Ada Lovelace");
  for (const input of d.querySelectorAll('input[type="text"], input[type="email"], input[type="url"]')) {
    if (!input.value) input.value = "answer";
  }
  const yes = d.querySelector('input[type="radio"][value="Yes"]');
  if (yes) yes.checked = true;

  const sub = buildSubmission(dom);

  assert.equal(sub.status, "submitted");
  assert.equal(sub.submittedAt, NOW);
  assert.match(sub.formSignature, /^https:\/\/jobs\.lever\.co\/whoop\/:uuid\/apply#/);
  assert.equal(sub.resolverVersion, collect.RESOLVER_VERSION);

  // Every stored field must carry a question a human can read back.
  assert.ok(sub.fields.length >= 5, `expected a full document, got ${sub.fields.length} fields`);
  for (const f of sub.fields) {
    assert.ok(f.label && f.label.trim(), `field ${f.key} stored with no label`);
  }

  const authorization = sub.fields.find((f) => f.label.startsWith("Are you legally authorized"));
  assert.ok(authorization, "the work-authorization question is missing");
  assert.equal(authorization.value, "Yes");
});
