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
   * The gate — is this a form the user submitted, or something else entirely?
   *
   * Pure over the draft plus two scope facts the caller tracks (`sawAuth`, a
   * password field was seen; `submit`, an explicit submit fired for this scope).
   *
   * Three rules, in order of how much noise each removes.
   */
  function isFormLike(draft, { sawAuth = false, submit = false } = {}) {
    // 1. Only on submit. A form still being filled in, or wandered away from, is
    //    never archived — nothing reaches disk until it is actually sent.
    if (!submit) return false;

    const fs = Object.values(draft.fields);
    const isCore = (f) => f.kind === "text" || f.kind === "choice" || f.kind === "picker";
    const core = fs.filter(isCore);
    const present = core.length;
    const filled = core.filter(hasValue).length;
    // Only prose the user composed. Choosing a colour and a model from two
    // dropdowns is not writing an answer — that is a product configurator, and
    // this is the rule that keeps it out.
    const wrote = core.filter((f) => f.kind === "text" && hasValue(f)).length;

    // 2. At least two answers, at least one of them written rather than picked.
    if (present < 2 || filled < 2 || wrote < 1) return false;

    // 3. Never a login or signup: a password beside a couple of fields, with
    //    nothing application-shaped. Checkboxes deliberately do not count —
    //    "Remember me" and "I accept the terms" are on nearly every such form.
    const hasRichData = fs.some((f) => ["textarea", "file"].includes(f.inputType));
    if (sawAuth && filled <= 2 && !hasRichData) return false;

    return true;
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
