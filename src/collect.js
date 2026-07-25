/**
 * Turning DOM state into a submission document.
 *
 * Kept free of event wiring and messaging so it can be tested under jsdom without
 * a browser or an extension context. capture.js owns the listeners; this owns the
 * shape of what gets stored.
 *
 * The central decision: a choice group collapses into ONE field whose value is the
 * chosen option(s). Storing each radio separately produced "Yes: on" and lost the
 * question, which is the whole point of a submission-as-document archive.
 */
(function (root, factory) {
  "use strict";
  const resolver =
    typeof module !== "undefined" && module.exports
      ? require("./field-identity.js")
      : root.FA.resolver;
  const redact =
    typeof module !== "undefined" && module.exports ? require("./redact.js") : root.FA.redact;

  const api = factory(resolver, redact);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.FA = root.FA || {};
  root.FA.collect = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (resolver, redact) {
  "use strict";

  const RESOLVER_VERSION = 1;
  const CHOICE_TYPES = new Set(["radio", "checkbox", "switch"]);

  const isChoice = (type) => CHOICE_TYPES.has(type);

  /** Current value of a control, or null when it holds nothing. */
  function readValue(el) {
    const tag = el.tagName.toLowerCase();
    const type = resolver.fieldType ? resolver.fieldType(el) : (el.type || tag).toLowerCase();

    if (isChoice(type)) {
      const checked =
        typeof el.checked === "boolean"
          ? el.checked
          : el.getAttribute("aria-checked") === "true";
      return checked ? true : false;
    }
    if (type === "file") {
      // Names only. File contents are never read.
      return Array.from(el.files || [])
        .map((f) => f.name)
        .join(", ");
    }
    if (tag === "select") {
      const picked = Array.from(el.selectedOptions || [])
        .map((o) => (o.textContent || o.value || "").trim())
        .filter(Boolean);
      return picked.join(", ");
    }
    if (tag === "input" || tag === "textarea") return el.value || "";
    // contenteditable and role=textbox widgets
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function createDraft({ id, scopeKey, url, origin, pathNormalized, title, now }) {
    return {
      id,
      scopeKey,
      url,
      origin,
      pathNormalized,
      pageTitle: title,
      formSignature: "",
      resolverVersion: RESOLVER_VERSION,
      startedAt: now,
      updatedAt: now,
      submittedAt: null,
      status: "draft",
      fields: {},
    };
  }

  /**
   * A choice group collapses onto its question so every option lands in one field.
   * Everything else is keyed by the element's own identity, supplied by the caller
   * (capture.js hands out stable ids via a WeakMap).
   */
  function fieldKey(record, elementId) {
    if (isChoice(record.inputType) && record.label) return `g:${record.label.toLowerCase()}`;
    return `e:${elementId}`;
  }

  /**
   * @param draft   draft to mutate
   * @param record  descriptor from the resolver (label, labelSource, inputType, …)
   * @param value   readValue() output — string for scalars, boolean for choices
   * @param elementId stable per-element id from the caller
   */
  function upsertField(draft, record, value, elementId, now) {
    const key = fieldKey(record, elementId);
    const existing = draft.fields[key];
    const field = existing || {
      key,
      order: Object.keys(draft.fields).length,
      label: record.label,
      labelSource: record.labelSource,
      confidence: record.confidence,
      inputType: record.inputType,
      // Drives the form-likeness gate: "text"/"choice" answers count, "passenger"
      // (volume, colour, toggle) and "search" never make a page look like a form.
      kind: record.kind || "text",
      name: record.name,
      domId: record.domId,
      value: "",
      options: [],
      redacted: false,
    };

    if (isChoice(record.inputType)) {
      // A lone checkbox with no option name is a yes/no answer to its own label.
      // The element-id fallback only exists so two unnamed options in one group
      // cannot collide and delete each other.
      const option =
        record.optionLabel ||
        (record.inputType === "radio" ? `option ${elementId}` : "Yes");
      const set = new Set(field.options);
      if (value) set.add(option);
      else set.delete(option);
      field.options = [...set];
      field.value = field.options.join(", ");
    } else {
      const { value: safe, redacted, reason } = redact.redactValue(String(value), record.label);
      field.value = safe;
      field.redacted = redacted;
      if (reason) field.redactReason = reason;
    }

    draft.fields[key] = field;
    draft.updatedAt = now;
    return field;
  }

  /** Drop empty fields and order them, producing the record that gets stored. */
  function toSubmission(draft, status, now) {
    const fields = Object.values(draft.fields)
      .filter((f) => f.value !== "" || f.options.length)
      .sort((a, b) => a.order - b.order)
      .map((f, i) => ({ ...f, order: i }));

    return {
      ...draft,
      fields,
      status,
      submittedAt: status === "submitted" ? now : draft.submittedAt,
      updatedAt: now,
    };
  }

  const hasValue = (f) => f.value !== "" || f.options.length > 0;
  const isEmpty = (draft) => !Object.values(draft.fields).some(hasValue);

  /**
   * The gate — is this scope a form worth archiving, or media/social noise?
   *
   * Pure over the draft plus two scope facts the caller tracks (`sawAuth`, a
   * password field was seen; `submit`, an explicit submit fired). Passenger and
   * search fields never count toward the thresholds, so a volume slider, a like
   * toggle, or a lone search box can never clear the bar on their own.
   *
   * The floor is two filled answer fields — deliberately dropping single-field
   * pages, which is what let one volume drag become a record. A single field is
   * archived only when an explicit submit says it was really a form.
   */
  function isFormLike(draft, { sawAuth = false, submit = false } = {}) {
    const fs = Object.values(draft.fields);
    const isCore = (f) => f.kind === "text" || f.kind === "choice";
    const core = fs.filter(isCore);
    const present = core.length;
    const filled = core.filter(hasValue).length;
    const textish = core.filter((f) => f.kind === "text" && hasValue(f)).length;
    // A login/signup: an auth field, at most a couple of text fields, and nothing
    // that looks like an application. Checkboxes deliberately do NOT count —
    // "Remember me" and "I accept the terms" appear on nearly every login and
    // signup form, and counting them let every one of them through.
    const hasRichData = fs.some((f) => ["select", "textarea", "file"].includes(f.inputType));

    if (present < 2) return false;
    if (sawAuth && filled <= 2 && !hasRichData) return false;
    if (textish >= 1 && filled >= 2) return true;
    if (filled >= 3 && (textish >= 1 || submit)) return true;
    if (filled >= 1 && submit) return true;
    return false;
  }

  return {
    RESOLVER_VERSION,
    isChoice,
    readValue,
    createDraft,
    fieldKey,
    upsertField,
    isFormLike,
    toSubmission,
    isEmpty,
  };
});
