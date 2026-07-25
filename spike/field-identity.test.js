"use strict";

/**
 * Phase 0 gate, run against spike/fixture.html.
 *
 * The fixture deliberately contains the shapes that break naive resolvers:
 * no-<form> markup, fields with neither id nor name, shadow DOM, contenteditable,
 * a fieldset/legend radio group, and a field injected after initial parse.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

// Suppress the browser auto-run before requiring the resolver.
globalThis.__FORM_SPIKE_NO_AUTORUN = true;
const spike = require("../src/field-identity.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixture.html"), "utf8");

async function loadFixture() {
  const dom = new JSDOM(FIXTURE, {
    url: "https://boards.greenhouse.io/acme/jobs/4f8a1c92/apply",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  // fixture injects a late field at t=100ms
  await new Promise((r) => setTimeout(r, 200));
  return dom;
}

// jsdom has no layout engine, so every element reports zero client rects.
const OPTS = { checkVisibility: false };

test("meets the 80% coverage gate", async () => {
  const dom = await loadFixture();
  const result = spike.analyze(dom.window.document, dom.window.location, OPTS);

  assert.equal(result.totalFields, 13, "expected 13 capturable fields");
  assert.equal(result.readableFields, 12, "expected 12 to resolve above the readable threshold");
  assert.equal(result.coveragePct, 92.3);
  assert.ok(result.coveragePct >= 80, `coverage ${result.coveragePct}% is below the 80% gate`);
});

test("resolves each label via the expected rule", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const byName = Object.fromEntries(fields.map((f) => [f.name || f.label, f]));

  const expected = {
    fullname: ["Full name", "LABEL_FOR"],
    email: ["Email address", "LABEL_WRAPPING"],
    motivation: ["Why do you want to work here?", "ARIA_LABELLEDBY"],
    phone: ["Phone number", "ARIA_LABEL"],
    linkedin: ["LinkedIn URL", "PLACEHOLDER"],
    salary: ["Desired salary", "CONTAINER_TEXT"],
    yoe: ["Years of experience", "LABEL_FOR"],
    portfolio: ["Portfolio URL", "LABEL_FOR"],
    availability: ["Availability date", "LABEL_FOR"],
  };

  for (const [name, [label, source]] of Object.entries(expected)) {
    assert.ok(byName[name], `field "${name}" was not captured at all`);
    assert.equal(byName[name].label, label, `wrong label for "${name}"`);
    assert.equal(byName[name].labelSource, source, `wrong rule for "${name}"`);
  }
});

test("radio group inherits its fieldset legend", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const radios = fields.filter((f) => f.name === "authorized");

  assert.equal(radios.length, 2, "both radios should be captured individually");
  for (const r of radios) {
    assert.equal(r.label, "Work authorization");
    assert.equal(r.labelSource, "LEGEND");
  }
});

test("an unlabelled field does not steal the previous question's text", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const referral = fields.find((f) => f.name === "referral_source");

  // The regression this guards: scanning past the salary input would hand this
  // field the label "Desired salary" and report it as confidently resolved.
  assert.equal(referral.labelSource, "HUMANIZED_NAME");
  assert.equal(referral.label, "referral source");
  assert.ok(referral.confidence < spike.READABLE_THRESHOLD, "must count as unreadable");
});

test("never reads a <style> or <script> block as a label", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);

  // Caught on a live Greenhouse form: an inlined <style> between fields was
  // resolved as CONTAINER_TEXT, so a CSS rule scored as a confident label and
  // inflated coverage to a false 100%.
  for (const f of fields) {
    assert.ok(!/\{|opacity:|position:absolute/.test(f.label), `CSS leaked into label: "${f.label}"`);
  }
});

test("reaches into open shadow roots", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const portfolio = fields.find((f) => f.name === "portfolio");

  assert.ok(portfolio, "shadow DOM field was not found");
  assert.equal(portfolio.label, "Portfolio URL");
});

test("captures fields injected after initial parse", async () => {
  const dom = await loadFixture();
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  assert.ok(fields.find((f) => f.name === "availability"), "late-mounted field was not found");
});

test("excludes password, payment and hidden fields entirely", async () => {
  const dom = await loadFixture();
  const { fields, skipped } = spike.collectFields(dom.window.document, OPTS);

  assert.equal(skipped.excluded, 3, "password + cc-number + hidden");
  for (const banned of ["password", "card", "csrf_token"]) {
    assert.equal(fields.find((f) => f.name === banned), undefined, `"${banned}" must never be captured`);
  }
});

test("signature ignores field order and late injection", async () => {
  const dom = await loadFixture();
  const loc = dom.window.location;
  const { fields } = spike.collectFields(dom.window.document, OPTS);

  const shuffled = [...fields].reverse();
  assert.equal(
    spike.computeSignature(fields, loc),
    spike.computeSignature(shuffled, loc),
    "signature must not depend on DOM order"
  );
});

test("signature survives volatile path segments", () => {
  const fields = [{ label: "Full name", confidence: 1 }];
  const sig = (p) => spike.computeSignature(fields, { origin: "https://x.com", pathname: p });

  // Same form, different requisition id — must collapse to one identity.
  assert.equal(sig("/jobs/4f8a1c92e3b7d5a1/apply"), sig("/jobs/9c2b7f01a4e6d8b3/apply"));
  assert.equal(sig("/jobs/12345/apply"), sig("/jobs/99999/apply"));
  // Genuinely different forms must not collide.
  assert.notEqual(sig("/jobs/12345/apply"), sig("/jobs/12345/referral"));
});

/* ---------- regressions found against a real Ashby form ---------- */

const SAMPLE_URLS = {
  "ashby-ramp.html": "https://jobs.ashbyhq.com/ramp/cc0af88a-2a19-493d-93cf-c5090f986f1f/application",
  "lever-whoop.html": "https://jobs.lever.co/whoop/2b8ea4e2-e585-4e46-9e6c-6eefead4f437/apply",
  "tally-contact.html": "https://tally.so/templates/contact-form-template/dnWe3O",
  "google-forms-survey.html":
    "https://docs.google.com/forms/d/e/1FAIpQLSejmLMv5qlINX33YbnIt4YrtfRoWD2wWC0QdRAqkQQJONHXQA/viewform",
};

function loadSample(name) {
  const html = fs.readFileSync(path.join(__dirname, "samples", name), "utf8");
  return new JSDOM(html, { url: SAMPLE_URLS[name] });
}

test("ashby sample: everything but the unlabelled dropzone resolves", () => {
  const dom = loadSample("ashby-ramp.html");
  const result = spike.analyze(dom.window.document, dom.window.location, OPTS);

  // 11, not 9: the two file inputs are captured now, since a résumé's *filename*
  // is worth keeping. One of them — Ashby's "autofill from resume" dropzone — has
  // no label anywhere, and reports honestly as unresolved rather than inheriting
  // the nav breadcrumb ("OverviewApplication") or the job metadata block.
  assert.equal(result.totalFields, 11);
  assert.equal(result.readableFields, 10);
  assert.ok(result.coveragePct >= 90, `coverage fell to ${result.coveragePct}%`);

  const unresolved = result.fields.filter((f) => f.confidence < spike.READABLE_THRESHOLD);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].inputType, "file");
  assert.equal(unresolved[0].label, "", "an unlabelled field must not invent a label");
});

test("ashby: label[for] is matched against name when the field has no id", () => {
  const dom = loadSample("ashby-ramp.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const bayArea = fields.find((f) => f.name === "b28f8143-f219-4f61-9216-dab364f689c9");

  // Regression: this checkbox carries a name but no id, and Ashby points
  // label[for] at the name. Without the name fallback it scraped a stray
  // <button>No</button> and resolved to "No".
  assert.equal(bayArea.labelSource, "LABEL_FOR");
  assert.equal(bayArea.label, "Are you currently based in the San Francisco Bay Area?");
});

test("ashby: generic placeholders are rejected in favour of container text", () => {
  const dom = loadSample("ashby-ramp.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const location = fields.find((f) => f.label.startsWith("Where do you plan"));

  // Regression: this combobox has no id and only placeholder="Start typing...",
  // which outranked the real question text sitting one level up.
  assert.ok(location, "location combobox lost its label");
  assert.equal(location.labelSource, "CONTAINER_TEXT");
  assert.equal(fields.find((f) => /^(Start typing|Type here)/.test(f.label)), undefined);
});

test("ashby: anti-bot tokens are excluded", () => {
  const dom = loadSample("ashby-ramp.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  assert.equal(fields.find((f) => /recaptcha/i.test(f.name)), undefined);
});

test("isUsefulPlaceholder keeps real labels and drops format hints", () => {
  const keep = ["LinkedIn URL", "Desired salary", "Portfolio website"];
  const drop = [
    "Type here...", "Start typing...", "Select...", "Search",
    "hello@example.com...", "1-415-555-1234...", "e.g. Acme Inc", "MM/DD/YYYY",
  ];
  const doc = new JSDOM("<input>").window.document;
  const probe = (ph) => {
    const el = doc.querySelector("input");
    el.setAttribute("placeholder", ph);
    return spike.resolveLabel(el, doc).source;
  };
  for (const ph of keep) assert.equal(probe(ph), "PLACEHOLDER", `should keep "${ph}"`);
  for (const ph of drop) assert.notEqual(probe(ph), "PLACEHOLDER", `should drop "${ph}"`);
});

test("ashby uuid paths normalize to one form identity", () => {
  const fields = [{ label: "Legal Name", confidence: 1 }];
  const sig = (p) => spike.computeSignature(fields, { origin: "https://jobs.ashbyhq.com", pathname: p });
  assert.equal(
    sig("/ramp/cc0af88a-2a19-493d-93cf-c5090f986f1f/application"),
    sig("/ramp/16fb536d-fe10-4ea7-8956-d6d0cbddd6f5/application")
  );
});

/* ---------- regressions found against a real Lever form ---------- */

test("lever sample: everything but the unlabelled upload resolves", () => {
  const dom = loadSample("lever-whoop.html");
  const result = spike.analyze(dom.window.document, dom.window.location, OPTS);

  assert.equal(result.coveragePct, 100);
  assert.ok(result.totalFields >= 24, `expected the full form, got ${result.totalFields} fields`);

  // Regression: a flat length cap on guessed labels rejected this question and
  // dropped its radios back to labels of "Yes"/"No". Length is the wrong
  // discriminator for page-content junk; concatenation seams are the right one.
  const hybrid = result.fields.find((f) => f.label.startsWith("This is a hybrid role"));
  assert.ok(hybrid, "the longest question lost its label");
  assert.ok(hybrid.label.length > 120, "expected a question longer than the old cap");
});

test("lever: a radio group is labelled by its question, not its option", () => {
  const dom = loadSample("lever-whoop.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const radios = fields.filter((f) => f.inputType === "radio");

  // Regression: the wrapping <label> names the option ("Yes"), which would store
  // a submission as "Yes: on" and lose the question entirely.
  assert.ok(radios.length >= 8, "expected the custom-question radios");
  for (const r of radios) {
    assert.equal(r.labelSource, "GROUP_TEXT");
    assert.notEqual(r.label, "Yes");
    assert.notEqual(r.label, "No");
    assert.ok(["Yes", "No"].includes(r.optionLabel), `option not captured: "${r.optionLabel}"`);
  }
  assert.ok(
    radios.some((r) => r.label.startsWith("Are you legally authorized to work")),
    "expected the work-authorization question as a label"
  );
});

test("lever: a wrapping label ignores text that follows the control", () => {
  const dom = loadSample("lever-whoop.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);

  // Regression: the location combobox hides "No location found. Try entering a
  // different location" and "Loading" after the input, inside the same <label>.
  const location = fields.find((f) => f.label.startsWith("Current location"));
  assert.ok(location, "location field missing");
  assert.equal(location.label, "Current location ✱");
  for (const f of fields) {
    assert.ok(!/No location found|Loading/.test(f.label), `dropdown state leaked: "${f.label}"`);
  }
});

test("lever: EEO self-identification fields are present and must be treated as sensitive", () => {
  const dom = loadSample("lever-whoop.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const labels = fields.map((f) => f.label);

  // Not a resolver assertion — a standing reminder that real application forms
  // carry GDPR Article 9 special-category data, which drives the retention and
  // redaction design.
  for (const sensitive of ["Gender", "Race", "Veteran status"]) {
    assert.ok(labels.includes(sensitive), `expected EEO field "${sensitive}" in the sample`);
  }
});

/* ---------- non-ATS platforms: Google Forms and Tally ---------- */

test("tally: every field resolves via aria-label", () => {
  const dom = loadSample("tally-contact.html");
  const result = spike.analyze(dom.window.document, dom.window.location, OPTS);

  assert.equal(result.coveragePct, 100);
  assert.equal(result.totalFields, 5);
  // Tally has no name attribute anywhere and UUID ids — id/name keying is useless.
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  assert.ok(fields.every((f) => f.name === ""), "Tally fields carry no name");
  assert.ok(fields.every((f) => f.labelSource === "ARIA_LABEL"));
  assert.ok(fields.some((f) => f.label === "Your question"));
});

test("google forms: ARIA choice widgets are captured at all", () => {
  const dom = loadSample("google-forms-survey.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);

  // Regression: Google Forms renders choices as <div role="radio">/<div role="checkbox">.
  // A native input/textarea/select selector sees none of them, which cost ~73% of
  // this form before ARIA widgets were added to the selector.
  const radios = fields.filter((f) => f.inputType === "radio");
  const checkboxes = fields.filter((f) => f.inputType === "checkbox");
  assert.ok(radios.length >= 3, `expected div[role=radio] widgets, got ${radios.length}`);
  assert.ok(checkboxes.length >= 3, `expected div[role=checkbox] widgets, got ${checkboxes.length}`);
});

test("google forms: radio AND checkbox groups both resolve to their question", () => {
  const dom = loadSample("google-forms-survey.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);

  // Radios sit under role="radiogroup"; checkboxes under role="list". Both carry
  // the question via aria-labelledby, which is why group detection climbs to the
  // nearest labelled ancestor rather than matching a fixed role list.
  const calculus = fields.filter((f) => f.label.startsWith("How would you best describe"));
  assert.equal(calculus.length, 3, "radiogroup question not applied to every option");
  assert.ok(calculus.every((f) => f.labelSource === "GROUP_TEXT"));

  const courses = fields.filter((f) => f.label.startsWith("Which of the following math courses"));
  assert.equal(courses.length, 3, "role=list checkbox group question not applied");
  assert.deepEqual(courses.map((f) => f.optionLabel), ["Math Mb", "Math 1a", "Math 1b"]);
});

test("google forms: the __other_option__ sentinel is humanised", () => {
  const dom = loadSample("google-forms-survey.html");
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  assert.ok(fields.some((f) => f.optionLabel === "Other"), "expected Other option");
  assert.equal(fields.find((f) => f.optionLabel === "__other_option__"), undefined);
});

test("google forms: entry.* and anti-tamper hidden inputs are excluded", () => {
  const dom = loadSample("google-forms-survey.html");
  const { fields, skipped } = spike.collectFields(dom.window.document, OPTS);
  assert.ok(skipped.excluded >= 6, "expected the hidden entry.* pile to be excluded");
  for (const junk of ["fvv", "fbzx", "tag", "pageHistory"]) {
    assert.equal(fields.find((f) => f.name === junk), undefined, `"${junk}" must not be captured`);
  }
});

test("an empty label never counts as resolved", () => {
  // Caught on a live w3schools page: a <label> containing only an icon fired
  // LABEL_WRAPPING and scored 0.95 with an empty string, inflating coverage.
  const dom = new JSDOM('<body><label><span></span><input name="x"></label></body>', {
    url: "https://x.com/f",
  });
  const { fields } = spike.collectFields(dom.window.document, OPTS);
  const f = fields[0];
  assert.ok(f.confidence < spike.READABLE_THRESHOLD, `empty label scored ${f.confidence}`);
});

test("normalizePath collapses ids but leaves words alone", () => {
  assert.equal(spike.normalizePath("/careers/12345/apply"), "/careers/:num/apply");
  assert.equal(
    spike.normalizePath("/j/3f2504e0-4f89-11d3-9a0c-0305e82c3301/form"),
    "/j/:uuid/form"
  );
  assert.equal(spike.normalizePath("/apply/software-engineer"), "/apply/software-engineer");
});

test("humanize turns machine names into prose", () => {
  assert.equal(spike.humanize("referral_source"), "referral source");
  assert.equal(spike.humanize("candidate.firstName"), "candidate first name");
  assert.equal(spike.humanize("input$47--why_us"), "input 47 why us");
});
