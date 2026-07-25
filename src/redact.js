/**
 * Value-level redaction.
 *
 * The field-level exclusions in field-identity.js (password inputs, cc-* autocomplete
 * tokens, hidden inputs, anti-bot tokens) are the first line. This is the second:
 * a card number typed into a plain text box carries no autocomplete hint, and an
 * SSN box is often just <input type="text" name="ssn">.
 *
 * Redaction replaces the value and records why. The field itself is still stored —
 * losing "you answered the SSN question" would be worse than losing the digits.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FA = root.FA || {};
  root.FA.redact = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const REDACTED = "[redacted]";

  // Labels that mean "whatever is in this box is sensitive", regardless of shape.
  const SENSITIVE_LABEL =
    /\b(ssn|social security|passport|national insurance|nino|aadhaar|pan number|tax id|tin\b|driver'?s? licen[cs]e|card number|cvv|cvc|security code|routing number|account number|sort code|iban|date of birth|dob|password|passphrase|passcode|\bpin\b|one[- ]time code|verification code|otp\b|mfa\b|2fa\b|recovery code|api key|secret key|private key)\b/i;

  function luhnValid(digits) {
    let sum = 0;
    let alternate = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (alternate) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alternate = !alternate;
    }
    return sum % 10 === 0;
  }

  // 13–19 digits that pass Luhn. Separators are ignored so "4111 1111 1111 1111"
  // is caught, but a bare 16-digit order number that fails Luhn is not.
  function looksLikeCard(value) {
    const digits = value.replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(digits)) return false;
    return luhnValid(digits);
  }

  // Dashed or spaced SSN is unambiguous. A bare 9-digit run is not — it is just as
  // likely an employee or order number — so that only redacts when the label agrees.
  function looksLikeSSN(value, label) {
    if (/^\d{3}[- ]\d{2}[- ]\d{4}$/.test(value.trim())) return true;
    return /^\d{9}$/.test(value.trim()) && SENSITIVE_LABEL.test(label || "");
  }

  /**
   * @returns {{value: string, redacted: boolean, reason?: string}}
   */
  function redactValue(value, label) {
    if (typeof value !== "string" || !value) return { value, redacted: false };

    if (SENSITIVE_LABEL.test(label || "")) {
      return { value: REDACTED, redacted: true, reason: "sensitive-label" };
    }
    if (looksLikeSSN(value, label)) {
      return { value: REDACTED, redacted: true, reason: "ssn-pattern" };
    }
    if (looksLikeCard(value)) {
      return { value: REDACTED, redacted: true, reason: "card-luhn" };
    }
    return { value, redacted: false };
  }

  return { redactValue, looksLikeCard, looksLikeSSN, luhnValid, SENSITIVE_LABEL, REDACTED };
});
