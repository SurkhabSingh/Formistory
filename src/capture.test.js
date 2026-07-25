"use strict";

/**
 * Integration test for the content script.
 *
 * Loads the four content-script files into a jsdom window in the same order the
 * manifest does, with a stubbed extension API, then drives real DOM events and
 * asserts on what would have been sent to the background.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const CONTENT_SCRIPTS = ["field-identity.js", "redact.js", "collect.js", "capture.js"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(html, url = "https://jobs.example.com/apply") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const ctx = dom.getInternalVMContext();
  const sent = [];

  ctx.chrome = {
    runtime: {
      id: "test-extension-id",
      sendMessage(msg) {
        sent.push(msg);
        return Promise.resolve({ ok: true });
      },
    },
  };

  for (const file of CONTENT_SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    vm.runInContext(src, ctx, { filename: file });
  }
  return { dom, sent, doc: dom.window.document };
}

function fire(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
}

const APPLICATION = `
  <body>
    <form>
      <label for="n">Full name</label><input id="n" name="n">
      <label for="w">Why do you want to work here?</label><textarea id="w" name="w"></textarea>
      <label>Password <input type="password" name="pw"></label>
      <fieldset><legend>Work authorization</legend>
        <label><input type="radio" name="auth" value="Yes"> Yes</label>
        <label><input type="radio" name="auth" value="No"> No</label>
      </fieldset>
      <button type="submit">Submit application</button>
    </form>
  </body>`;

test("typing produces a draft carrying question and answer", async () => {
  const { dom, sent, doc } = boot(APPLICATION);

  // Two fields: the gate needs two filled answers before a page counts as a form,
  // so one control alone (a volume slider, a like toggle) can never trigger it.
  doc.getElementById("n").value = "Ada Lovelace";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("w").value = "The problem is interesting.";
  fire(doc.getElementById("w"), "input");
  await sleep(1000); // clear the 800ms debounce

  assert.ok(sent.length >= 1, "nothing was sent to the background");
  const { submission } = sent.at(-1);
  assert.equal(sent.at(-1).type, "submission/put");
  assert.equal(submission.status, "draft");

  const name = submission.fields.find((f) => f.label === "Full name");
  assert.ok(name, "the typed field is missing from the draft");
  assert.equal(name.value, "Ada Lovelace");
  dom.window.close();
});

test("submitting finalises the document with every answer", async () => {
  const { dom, sent, doc } = boot(APPLICATION);

  doc.getElementById("n").value = "Ada Lovelace";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("w").value = "The problem is interesting.";
  fire(doc.getElementById("w"), "input");

  const yes = doc.querySelector('input[value="Yes"]');
  yes.checked = true;
  fire(yes, "change");

  fire(doc.querySelector("form"), "submit");
  await sleep(50);

  const submitted = sent.filter((m) => m.submission.status === "submitted");
  assert.ok(submitted.length, "submit did not finalise the draft");

  const doc1 = submitted.at(-1).submission;
  const answers = Object.fromEntries(doc1.fields.map((f) => [f.label, f.value]));
  assert.equal(answers["Full name"], "Ada Lovelace");
  assert.equal(answers["Why do you want to work here?"], "The problem is interesting.");
  assert.equal(answers["Work authorization"], "Yes");
  assert.equal(doc1.formSignature.startsWith("https://jobs.example.com/apply#"), true);
  dom.window.close();
});

test("a password is never sent, even after being typed into", async () => {
  const { dom, sent, doc } = boot(APPLICATION);

  const pw = doc.querySelector('input[type="password"]');
  pw.value = "hunter2";
  fire(pw, "input");
  // Two non-password answers, so the form clears the gate and we can prove the
  // password is absent from what was sent. The narrowed auth rule keeps this form
  // (it has a textarea and a radio group — not a bare login).
  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("w").value = "Because.";
  fire(doc.getElementById("w"), "input");
  fire(doc.querySelector("form"), "submit");
  await sleep(50);

  assert.ok(sent.length, "expected the non-password field to still be captured");
  assert.ok(!JSON.stringify(sent).includes("hunter2"), "password reached the background");
  dom.window.close();
});

test("a form with no <form> element is still captured", async () => {
  // Ashby's application has no <form> at all and never navigates, so the
  // page-level bucket is the only thing that captures it. Two fields, per the
  // form-likeness floor.
  const { dom, sent, doc } = boot(
    `<body><div>
       <label for="exp">Describe your experience</label><input id="exp" name="exp">
       <label for="loc">Where are you based?</label><input id="loc" name="loc">
     </div></body>`
  );

  doc.getElementById("exp").value = "Ten years of it.";
  fire(doc.getElementById("exp"), "input");
  doc.getElementById("loc").value = "Chandigarh";
  fire(doc.getElementById("loc"), "input");
  await sleep(1000);

  assert.ok(sent.length, "no draft was produced for a form-less page");
  const submission = sent.at(-1).submission;
  assert.equal(submission.scopeKey, "page");
  const a = Object.fromEntries(submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Describe your experience"], "Ten years of it.");
  assert.equal(a["Where are you based?"], "Chandigarh");
  dom.window.close();
});

test("prefilled fields the user never touched are still archived", async () => {
  // The gap this closes: journaling input events alone captures only what was
  // typed. LinkedIn Easy Apply prefills name/email/phone from your profile, so
  // the archived application was missing exactly the answers you didn't retype.
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="n">Full name</label><input id="n" name="n" value="Ada Lovelace">
      <label for="e">Email</label><input id="e" name="e" value="ada@example.com">
      <label for="w">Why this role?</label><textarea id="w" name="w"></textarea>
      <button type="submit">Submit application</button>
    </form></body>`);

  doc.getElementById("w").value = "Because.";
  fire(doc.getElementById("w"), "input");
  fire(doc.querySelector("form"), "submit");
  await sleep(50);

  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Why this role?"], "Because.");
  assert.equal(a["Full name"], "Ada Lovelace", "prefilled field was lost");
  assert.equal(a["Email"], "ada@example.com", "prefilled field was lost");
  dom.window.close();
});

test("fields inside open shadow roots are captured", async () => {
  const { dom, sent, doc } = boot(`<body><form>
      <label for="light">Light DOM field</label><input id="light" name="light">
      <div id="host"></div>
    </form></body>`);

  const shadow = doc.getElementById("host").attachShadow({ mode: "open" });
  // name is "bio", not "s": a field named "s" is now classified as a search box.
  shadow.innerHTML = `<label for="bio">Shadow field</label><input id="bio" name="bio">`;
  const inner = shadow.getElementById("bio");

  doc.getElementById("light").value = "in the light";
  fire(doc.getElementById("light"), "input");

  inner.value = "typed in shadow";
  // Events crossing a shadow boundary retarget to the host, so reading e.target
  // at document level yielded a non-field and dropped this silently.
  inner.dispatchEvent(new dom.window.Event("input", { bubbles: true, composed: true }));
  await sleep(1000);

  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Shadow field"], "typed in shadow");
  dom.window.close();
});

test("the sweep does not invent records for forms nobody touched", async () => {
  // A prefilled search box on an ordinary page must not manufacture a document,
  // and touching one real form must not drag in an untouched neighbouring one.
  const { dom, sent, doc } = boot(`
    <body>
      <form id="search"><label for="q">Search</label><input id="q" name="q" value="prefilled"></form>
      <form id="contact">
        <label for="nm">Name</label><input id="nm" name="nm">
        <label for="m">Message</label><textarea id="m" name="m"></textarea>
      </form>
    </body>`);

  doc.getElementById("nm").value = "Ada";
  fire(doc.getElementById("nm"), "input");
  doc.getElementById("m").value = "Hello";
  fire(doc.getElementById("m"), "input");
  await sleep(1000);

  const all = sent.flatMap((s) => s.submission.fields.map((f) => f.label));
  assert.ok(all.includes("Message"), "the touched form was not captured");
  assert.ok(!all.includes("Search"), "an untouched search form was captured anyway");
  dom.window.close();
});

test("a file input records the filename and never the contents", async () => {
  const { dom, sent, doc } = boot(`<body><form>
      <label for="r">Résumé</label><input id="r" name="r" type="file">
      <label for="n">Name</label><input id="n" name="n">
    </form></body>`);

  const file = new dom.window.File(["binary-contents-here"], "resume-v3.pdf", { type: "application/pdf" });
  Object.defineProperty(doc.getElementById("r"), "files", { value: [file] });

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  fire(doc.querySelector("form"), "submit");
  await sleep(50);

  const raw = JSON.stringify(sent.at(-1).submission);
  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Résumé"], "resume-v3.pdf");
  assert.ok(!raw.includes("binary-contents-here"), "file contents were read");
  dom.window.close();
});

/* ---------- repeated submits must not pile up duplicates ---------- */

const REQUIRED_FORM = `
  <body><form>
    <label for="n">Full name</label><input id="n" name="n" required>
    <label for="e">Email</label><input id="e" name="e" type="email" required>
    <label for="c">Company</label><input id="c" name="c">
    <button type="button" id="go">Submit application</button>
  </form></body>`;

test("clicking submit repeatedly updates one record instead of adding copies", async () => {
  const { dom, sent, doc } = boot(REQUIRED_FORM);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("e").value = "ada@example.com";
  fire(doc.getElementById("e"), "input");

  click(doc.getElementById("go"));
  await sleep(40);
  click(doc.getElementById("go"));
  await sleep(40);
  click(doc.getElementById("go"));
  await sleep(40);

  // One application, however many times the button was pressed.
  const ids = new Set(sent.map((m) => m.submission.id));
  assert.equal(ids.size, 1, `expected one record id, got ${ids.size}`);
  dom.window.close();
});

test("a submit blocked by validation is not recorded as submitted", async () => {
  const { dom, sent, doc } = boot(REQUIRED_FORM);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  // Two fields filled (so the form clears the gate) but a required one — email —
  // left empty, so the submit is rejected.
  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("c").value = "Acme";
  fire(doc.getElementById("c"), "input");
  click(doc.getElementById("go"));
  await sleep(40);

  assert.ok(sent.length, "the partial answer should still be kept");
  assert.equal(
    sent.at(-1).submission.status,
    "draft",
    "a rejected submit must not be recorded as a completed application"
  );
  dom.window.close();
});

test("fixing the error and resubmitting completes the same record", async () => {
  const { dom, sent, doc } = boot(REQUIRED_FORM);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  click(doc.getElementById("go"));       // rejected: email missing
  await sleep(40);

  doc.getElementById("e").value = "ada@example.com";
  fire(doc.getElementById("e"), "input");
  click(doc.getElementById("go"));       // accepted
  await sleep(40);

  const ids = new Set(sent.map((m) => m.submission.id));
  assert.equal(ids.size, 1, "the retry created a second record");

  const final = sent.at(-1).submission;
  assert.equal(final.status, "submitted");
  const a = Object.fromEntries(final.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Full name"], "Ada");
  assert.equal(a["Email"], "ada@example.com");
  dom.window.close();
});

test("closing the tab does not relabel a submitted application as abandoned", async () => {
  const { dom, sent, doc } = boot(REQUIRED_FORM);
  const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("e").value = "ada@example.com";
  fire(doc.getElementById("e"), "input");
  click(doc.getElementById("go"));
  await sleep(40);

  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await sleep(20);

  assert.equal(sent.at(-1).submission.status, "submitted", "status was downgraded on unload");
  dom.window.close();
});

test("nothing is sent when no field has been touched", async () => {
  const { dom, sent, doc } = boot(APPLICATION);
  fire(doc.querySelector("form"), "submit");
  await sleep(50);
  assert.equal(sent.length, 0, "an empty form should produce no record");
  dom.window.close();
});

/* ---------- code-review regressions ---------- */

test("a password revealed by a show/hide toggle is still never stored", async () => {
  // The eye icon rewrites type=password to type=text. Deciding from the current
  // type alone wrote a labelled plaintext credential to disk.
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="u">Username</label><input id="u" name="u">
      <label for="p">Password</label><input id="p" name="p" type="password">
      <label for="bio">About you</label><textarea id="bio" name="bio"></textarea>
      <button type="submit">Sign in</button>
    </form></body>`);

  const pw = doc.getElementById("p");
  pw.value = "hunter2";
  fire(pw, "input");
  pw.type = "text"; // "show password"
  fire(pw, "input");

  doc.getElementById("u").value = "ada";
  fire(doc.getElementById("u"), "input");
  doc.getElementById("bio").value = "Engineer.";
  fire(doc.getElementById("bio"), "input");
  fire(doc.querySelector("form"), "submit");
  await sleep(60);

  assert.ok(!JSON.stringify(sent).includes("hunter2"), "revealed password was archived");
  dom.window.close();
});

test("a login form is not archived just because it has a Remember me box", async () => {
  // "Remember me" / "I accept the terms" are on nearly every login and signup
  // form; counting them as rich data let all of them through the auth guard.
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="e">Email</label><input id="e" name="e" type="email">
      <label for="p">Password</label><input id="p" name="p" type="password">
      <label><input type="checkbox" name="remember"> Remember me</label>
      <button type="submit">Sign in</button>
    </form></body>`);

  doc.getElementById("e").value = "ada@example.com";
  fire(doc.getElementById("e"), "input");
  doc.getElementById("p").value = "hunter2";
  fire(doc.getElementById("p"), "input");
  const box = doc.querySelector('[name="remember"]');
  box.checked = true;
  fire(box, "change");
  fire(doc.querySelector("form"), "submit");
  await sleep(60);

  assert.equal(sent.length, 0, `a login form was archived: ${JSON.stringify(sent)}`);
  dom.window.close();
});

test("clearing a field removes the answer from the record", async () => {
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="n">Full name</label><input id="n" name="n">
      <label for="x">Anything else?</label><textarea id="x" name="x"></textarea>
    </form></body>`);

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("x").value = "my private phone number";
  fire(doc.getElementById("x"), "input");
  await sleep(1000);
  assert.ok(JSON.stringify(sent).includes("private phone"), "setup: value was never captured");

  // Thought better of it.
  doc.getElementById("x").value = "";
  fire(doc.getElementById("x"), "input");
  await sleep(1000);

  const last = sent.at(-1);
  if (last.type === "submission/delete") {
    // Dropping below the two-field floor retires the record entirely.
    assert.ok(last.id, "delete message carried no id");
  } else {
    assert.ok(
      !last.submission.fields.some((f) => /private phone/.test(f.value)),
      "the deleted answer is still in the archive"
    );
  }
  dom.window.close();
});

test("a record is retired when its form drops below the floor", async () => {
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="n">Full name</label><input id="n" name="n">
      <label for="x">Anything else?</label><textarea id="x" name="x"></textarea>
    </form></body>`);

  for (const [id, v] of [["n", "Ada"], ["x", "secret"]]) {
    doc.getElementById(id).value = v;
    fire(doc.getElementById(id), "input");
  }
  await sleep(1000);
  const stored = sent.at(-1).submission.id;

  for (const id of ["n", "x"]) {
    doc.getElementById(id).value = "";
    fire(doc.getElementById(id), "input");
  }
  await sleep(1000);

  const del = sent.filter((m) => m.type === "submission/delete");
  assert.ok(del.length, "an emptied form left its record on disk");
  assert.equal(del.at(-1).id, stored, "deleted the wrong record");
  dom.window.close();
});

test("submitting one form does not mark another form as submitted", async () => {
  const { dom, sent, doc } = boot(`
    <body>
      <form id="a">
        <label for="a1">Your name</label><input id="a1" name="a1">
        <label for="a2">Your message</label><textarea id="a2" name="a2"></textarea>
        <button type="submit">Send message</button>
      </form>
      <form id="b">
        <label for="b1">Job title</label><input id="b1" name="b1">
        <label for="b2">Cover letter</label><textarea id="b2" name="b2"></textarea>
      </form>
    </body>`);

  for (const id of ["a1", "a2", "b1", "b2"]) {
    doc.getElementById(id).value = "filled";
    fire(doc.getElementById(id), "input");
  }
  await sleep(1000);
  fire(doc.getElementById("a"), "submit");
  await sleep(60);

  const bRecords = sent.filter((m) => m.submission.fields.some((f) => f.label === "Cover letter"));
  assert.ok(bRecords.length, "setup: the second form was never captured");
  assert.notEqual(
    bRecords.at(-1).submission.status,
    "submitted",
    "an untouched form was marked submitted by its neighbour"
  );
  dom.window.close();
});

test("one stray aria-invalid elsewhere does not suppress submit detection", async () => {
  // Ashby/Workday/LinkedIn have no <form>, so scanning the whole document meant a
  // single invalid field anywhere permanently disabled submit detection.
  const { dom, sent, doc } = boot(`
    <body>
      <aside><input aria-label="Promo code" aria-invalid="true"></aside>
      <div id="app">
        <label for="q1">Describe your experience</label><input id="q1" name="q1">
        <label for="q2">Why this role?</label><textarea id="q2" name="q2"></textarea>
        <button type="button" id="go">Submit application</button>
      </div>
    </body>`);

  doc.getElementById("q1").value = "Ten years.";
  fire(doc.getElementById("q1"), "input");
  doc.getElementById("q2").value = "Because.";
  fire(doc.getElementById("q2"), "input");
  await sleep(1000);
  click(dom, doc.getElementById("go"));
  await sleep(60);

  assert.equal(sent.at(-1).submission.status, "submitted", "submit was wrongly treated as rejected");
  dom.window.close();
});

test("the sweep stays inside the form region on an SPA layout", async () => {
  // The regression this pins: <main>/<article>/<section> were not treated as
  // boundaries, so the climb reached the app root and harvested the whole page.
  const { dom, sent, doc } = boot(`
    <body><main>
      <div id="widget">
        <label for="c1">Add a comment</label><input id="c1" name="c1">
        <label for="c2">Display name</label><input id="c2" name="c2">
      </div>
      <div id="elsewhere">
        <label for="addr">Home address</label><input id="addr" name="addr" value="10 Downing St">
        <label for="emp">Employer</label><input id="emp" name="emp" value="Acme">
      </div>
    </main></body>`);

  doc.getElementById("c1").value = "great";
  fire(doc.getElementById("c1"), "input");
  doc.getElementById("c2").value = "ada";
  fire(doc.getElementById("c2"), "input");
  await sleep(1000);

  const labels = sent.flatMap((m) => m.submission.fields.map((f) => f.label));
  assert.ok(!labels.includes("Home address"), "the sweep escaped the widget region");
  assert.ok(!labels.includes("Employer"), "the sweep escaped the widget region");
  dom.window.close();
});

test("secrets in the page URL are not stored", async () => {
  const { dom, sent, doc } = boot(
    `<body><form>
       <label for="n">Name</label><input id="n" name="n">
       <label for="m">Message</label><textarea id="m" name="m"></textarea>
     </form></body>`,
    "https://example.com/invite?token=SECRET123&ref=newsletter"
  );

  doc.getElementById("n").value = "Ada";
  fire(doc.getElementById("n"), "input");
  doc.getElementById("m").value = "Hello";
  fire(doc.getElementById("m"), "input");
  await sleep(1000);

  const raw = JSON.stringify(sent);
  assert.ok(!raw.includes("SECRET123"), "a URL token was archived");
  assert.ok(raw.includes("ref=newsletter"), "a harmless parameter was needlessly stripped");
  dom.window.close();
});

/* ---------- media / social noise must never be archived ---------- */

const click = (dom, el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

test("a volume slider and a like toggle produce no record", async () => {
  // The shipped bug: dragging YouTube volume created a record. A range and an
  // aria toggle are passengers — they can never make a page look like a form.
  const { dom, sent, doc } = boot(`
    <body>
      <input id="vol" name="volume" type="range" min="0" max="100" value="50" aria-label="Volume">
      <div id="like" role="checkbox" aria-checked="false" aria-label="Like"></div>
      <div id="follow" role="switch" aria-checked="false" aria-label="Follow"></div>
    </body>`);

  const vol = doc.getElementById("vol");
  vol.value = "30";
  fire(vol, "input");
  vol.value = "70";
  fire(vol, "input");
  doc.getElementById("like").setAttribute("aria-checked", "true");
  fire(doc.getElementById("like"), "change");
  doc.getElementById("follow").setAttribute("aria-checked", "true");
  fire(doc.getElementById("follow"), "change");
  await sleep(1000);

  assert.equal(sent.length, 0, `media controls were archived: ${JSON.stringify(sent)}`);
  dom.window.close();
});

test("a lone search box produces no record", async () => {
  const { dom, sent, doc } = boot(
    `<body><form role="search"><input id="s" name="q" type="search"></form></body>`
  );
  doc.getElementById("s").value = "how to write a cover letter";
  fire(doc.getElementById("s"), "input");
  await sleep(1000);
  assert.equal(sent.length, 0, "a search box was archived");
  dom.window.close();
});

test("a field named 's' inside a real form is still kept", async () => {
  // The search heuristic must only demote a lone search box — not a legitimately
  // named field sitting among real answers.
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="s">School</label><input id="s" name="s">
      <label for="deg">Degree</label><input id="deg" name="deg">
      <label for="yr">Year</label><input id="yr" name="yr">
    </form></body>`);

  doc.getElementById("s").value = "Panjab University";
  fire(doc.getElementById("s"), "input");
  doc.getElementById("deg").value = "BSc";
  fire(doc.getElementById("deg"), "input");
  doc.getElementById("yr").value = "2021";
  fire(doc.getElementById("yr"), "input");
  await sleep(1000);

  assert.ok(sent.length, "a real form was rejected");
  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["School"], "Panjab University", "the field named 's' was dropped");
  dom.window.close();
});

test("a bank of setting checkboxes with no submit produces no record", async () => {
  // A cookie/consent banner or a settings panel: three checked boxes, no submit.
  const { dom, sent, doc } = boot(`
    <body><div>
      <label><input type="checkbox" name="c1"> Necessary</label>
      <label><input type="checkbox" name="c2"> Analytics</label>
      <label><input type="checkbox" name="c3"> Marketing</label>
    </div></body>`);

  for (const id of ["c1", "c2", "c3"]) {
    const box = doc.querySelector(`[name="${id}"]`);
    box.checked = true;
    fire(box, "change");
  }
  await sleep(1000);
  assert.equal(sent.length, 0, "a choice-only panel with no submit was archived");
  dom.window.close();
});

test("a passenger control on a real form is kept but does not gate it", async () => {
  // "Expected salary" as a range is a genuine answer on a real application — keep
  // it — but two real text answers are what make the page a form, not the slider.
  const { dom, sent, doc } = boot(`
    <body><form>
      <label for="role">Desired role</label><input id="role" name="role">
      <label for="loc">Location</label><input id="loc" name="loc">
      <label for="sal">Expected salary</label>
      <input id="sal" name="sal" type="range" min="40" max="250" value="120" aria-label="Expected salary">
    </form></body>`);

  doc.getElementById("role").value = "Engineer";
  fire(doc.getElementById("role"), "input");
  doc.getElementById("loc").value = "Remote";
  fire(doc.getElementById("loc"), "input");
  doc.getElementById("sal").value = "140";
  fire(doc.getElementById("sal"), "input");
  await sleep(1000);

  assert.ok(sent.length, "a real form with a range was rejected");
  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Expected salary"], "140", "the salary range was not kept");
  dom.window.close();
});

test("media page: the player yields nothing, the real form is captured", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../testbed/12-media-noise.html"), "utf8");
  const { dom, sent, doc } = boot(html, "https://videos.example.com/watch");

  // Fiddle with the whole player.
  const vol = doc.getElementById("vol");
  vol.value = "80";
  fire(vol, "input");
  doc.getElementById("like").setAttribute("aria-checked", "true");
  fire(doc.getElementById("like"), "change");
  doc.getElementById("site-search").value = "cats";
  fire(doc.getElementById("site-search"), "input");
  for (const box of doc.querySelectorAll('.player input[type="checkbox"]')) {
    box.checked = true;
    fire(box, "change");
  }
  await sleep(1000);
  assert.equal(sent.length, 0, `the player was archived: ${JSON.stringify(sent.map((s) => s.submission.fields))}`);

  // Now fill the real form.
  doc.getElementById("fb-name").value = "Ada";
  fire(doc.getElementById("fb-name"), "input");
  doc.getElementById("fb-email").value = "ada@example.com";
  fire(doc.getElementById("fb-email"), "input");
  doc.getElementById("fb-msg").value = "Nice site.";
  fire(doc.getElementById("fb-msg"), "input");
  click(dom, doc.getElementById("fb-send"));
  await sleep(60);

  assert.ok(sent.length, "the real form was not captured");
  const a = Object.fromEntries(sent.at(-1).submission.fields.map((f) => [f.label, f.value]));
  assert.equal(a["Your name"], "Ada");
  assert.equal(a["What did you think?"], "Nice site.");
  // The player's controls must not have leaked into the real form's record.
  const labels = sent.at(-1).submission.fields.map((f) => f.label);
  assert.ok(!labels.some((l) => /volume|like|autoplay|subtitle|accent/i.test(l)), "player noise leaked in");
  dom.window.close();
});
