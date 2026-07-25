"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { redactValue, looksLikeCard, luhnValid } = require("./redact.js");

test("redacts card numbers that pass Luhn, with or without separators", () => {
  for (const card of ["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"]) {
    const out = redactValue(card, "Card");
    assert.equal(out.redacted, true, `missed ${card}`);
    assert.equal(out.value, "[redacted]");
    assert.equal(out.reason, "card-luhn");
  }
});

test("leaves long digit strings that are not card numbers", () => {
  // A 16-digit order reference that fails Luhn must survive: over-redacting
  // silently destroys the answers this tool exists to keep.
  assert.equal(luhnValid("4111111111111112"), false);
  assert.equal(redactValue("4111111111111112", "Order number").redacted, false);
  assert.equal(redactValue("2024", "Graduation year").redacted, false);
  assert.equal(looksLikeCard("123456"), false);
});

test("redacts a dashed SSN regardless of label", () => {
  const out = redactValue("123-45-6789", "Anything at all");
  assert.equal(out.redacted, true);
  assert.equal(out.reason, "ssn-pattern");
});

test("a bare 9-digit run redacts only when the label agrees", () => {
  // Ambiguous on its own — just as likely an employee or reference number.
  assert.equal(redactValue("123456789", "Reference number").redacted, false);
  assert.equal(redactValue("123456789", "Social Security Number").redacted, true);
});

test("redacts by label even when the value looks harmless", () => {
  for (const label of ["SSN", "Passport number", "CVV", "IBAN", "Date of birth"]) {
    assert.equal(redactValue("whatever", label).redacted, true, `missed label "${label}"`);
  }
});

test("ordinary answers are untouched", () => {
  const answer = "I want to work here because the problem is interesting.";
  const out = redactValue(answer, "Why do you want to work here?");
  assert.equal(out.redacted, false);
  assert.equal(out.value, answer);
});

test("empty and non-string values are passed through safely", () => {
  assert.equal(redactValue("", "SSN").redacted, false);
  assert.equal(redactValue(null, "SSN").redacted, false);
});
