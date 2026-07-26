/**
 * Content script — watches form controls and streams drafts to the background.
 *
 * Runs in every frame (all_frames: true), because cross-origin iframes are a
 * separate context that the top frame cannot read into.
 *
 * Deliberately does NOT hang off the submit event. Ashby's application form has
 * no <form> element at all and never navigates, and Workday's is an eight-step
 * wizard — so capture journals input events and finalises on whichever end-of-form
 * signal arrives first.
 */
(function () {
  "use strict";

  const api = globalThis.browser ?? globalThis.chrome;
  const { resolver, collect } = globalThis.FA;

  // Turn on from any page's console with:  localStorage.FA_DEBUG = "1"
  // then reload. Silent failure is the enemy here — a form that captures nothing
  // looks identical to a form that was never visited.
  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem("FA_DEBUG") === "1";
  } catch {
    /* storage blocked by the page's own policy */
  }
  const log = (...args) => DEBUG && console.log("[formistory]", ...args);

  // Only real HTML documents. Skips XML, the PDF viewer, and extension pages.
  if (!document || document.contentType !== "text/html") return;
  if (location.protocol === "chrome-extension:" || location.protocol === "moz-extension:") return;

  const FLUSH_DEBOUNCE_MS = 800;

  const drafts = new Map(); // scopeKey -> draft
  const elementIds = new WeakMap(); // element -> stable id within this page
  const scopeIds = new WeakMap(); // <form> -> scope key
  const scopeFields = new Map(); // scopeKey -> Set<Element> of armed data fields
  const sentIds = new Set(); // draft ids already written, so they can be deleted
  const authScopes = new Set(); // scopeKeys where a password field was seen
  const submitScopes = new Set(); // scopeKeys where an explicit submit fired
  let nextElementId = 1;
  let flushTimer = null;
  // Query strings churn constantly on SPAs (LinkedIn rewrites currentJobId as you
  // browse), so only a real path change counts as "a different form now".
  let lastPath = location.origin + location.pathname;

  // Fixed for this page visit, so a draft keeps one identity across re-submits.
  const SESSION = Date.now();

  const now = () => Date.now();

  // Query parameters that carry credentials. Invite links, password resets and
  // unsubscribe flows put single-use tokens in the URL; storing the address
  // verbatim would archive the token and render it as a clickable link.
  const SECRET_PARAM = /(token|auth|key|secret|session|sig|signature|code|password|otp|access|refresh|email)/i;

  function safeUrl(href) {
    try {
      const u = new URL(href);
      for (const name of [...u.searchParams.keys()]) {
        if (SECRET_PARAM.test(name)) u.searchParams.set(name, "[redacted]");
      }
      u.hash = "";
      return u.toString();
    } catch {
      return href;
    }
  }

  function elementId(el) {
    let id = elementIds.get(el);
    if (!id) {
      id = nextElementId++;
      elementIds.set(el, id);
    }
    return id;
  }

  // A form boundary: a real <form>, or an ARIA form landmark. Treating
  // role="form" as a boundary keeps a form-less widget region (a media player, a
  // settings panel) from sharing the page bucket with a genuine form beside it.
  const SCOPE_SELECTOR = "form, [role=form]";

  // Group by form when there is one, otherwise treat the page as a single scope —
  // a page-level bucket is what makes no-<form> SPA applications capturable at all.
  // Keyed by the form's position, not its node identity: a wizard that re-renders
  // its <form> between steps would otherwise mint a fresh draft each step and
  // scatter one application across several documents.

  function scopeKeyFor(el) {
    // Cross the shadow boundary: a field inside a shadow root whose host lives in
    // a form belongs to that form, not to a separate "page" bucket.
    const form =
      el.closest(SCOPE_SELECTOR) ||
      (el.getRootNode().host && el.getRootNode().host.closest(SCOPE_SELECTOR));
    if (!form) return "page";
    const cached = scopeIds.get(form);
    if (cached !== undefined) return cached;
    const forms = Array.from(form.ownerDocument.querySelectorAll(SCOPE_SELECTOR));
    const index = forms.indexOf(form);
    const key = `form:${index < 0 ? 0 : index}`;
    scopeIds.set(form, key);
    return key;
  }

  function recordField(scopeKey, el) {
    let set = scopeFields.get(scopeKey);
    if (!set) {
      set = new Set();
      scopeFields.set(scopeKey, set);
    }
    set.add(el);
  }

  function draftFor(scopeKey) {
    let draft = drafts.get(scopeKey);
    if (!draft) {
      draft = collect.createDraft({
        // Stable for the visit: re-submitting after a validation error updates
        // this record instead of writing a second copy of the same application.
        id: `${location.origin}${resolver.normalizePath(location.pathname)}|${scopeKey}|${SESSION}`,
        scopeKey,
        url: safeUrl(location.href),
        origin: location.origin,
        pathNormalized: resolver.normalizePath(location.pathname),
        title: document.title,
        now: now(),
      });
      drafts.set(scopeKey, draft);
    }
    return draft;
  }

  function handleElement(el) {
    if (!el || !el.matches) return;
    if (!el.matches(resolver.FIELD_SELECTOR)) return;

    const kind = resolver.classify(el);
    const scopeKey = scopeKeyFor(el);

    if (kind === "excluded") {
      // A password field still marks the scope as auth, so the gate can reject
      // logins/signups even though the password itself is never stored.
      if (resolver.isAuthField(el)) authScopes.add(scopeKey);
      log("ignored (excluded)", el.getAttribute("name") || el.getAttribute("id") || el.type);
      return;
    }

    const value = collect.readValue(el);

    // Passengers (volume, colour, like toggle) and search boxes never arm a
    // draft. They are recorded only once the scope is *already* a form — a volume
    // drag on YouTube can therefore never manufacture a record.
    if (kind === "passenger" || kind === "search") {
      if (!drafts.has(scopeKey)) {
        log(`ignored (${kind}, no form here)`, el.getAttribute("aria-label") || el.type);
        return;
      }
      if (value === "" || value === false) return;
      collect.upsertField(drafts.get(scopeKey), resolver.describeField(el), value, elementId(el), now());
      scheduleFlush();
      return;
    }

    // A real answer. Arm only on a non-blank value, so an empty focusout never
    // creates a record — but once a draft exists, a cleared field must be written
    // through as empty. Deleting text you thought better of has to delete it from
    // the archive too.
    if (value === "" || value === false) {
      if (!drafts.has(scopeKey)) return;
      collect.upsertField(drafts.get(scopeKey), resolver.describeField(el), value, elementId(el), now());
      scheduleFlush();
      return;
    }

    recordField(scopeKey, el);
    collect.upsertField(draftFor(scopeKey), resolver.describeField(el), value, elementId(el), now());
    scheduleFlush();
  }

  /** Every field on the page, descending into open shadow roots. */
  function* allFields(root) {
    for (const el of root.querySelectorAll("*")) {
      if (el.matches(resolver.FIELD_SELECTOR)) yield el;
      if (el.shadowRoot) yield* allFields(el.shadowRoot);
    }
  }

  // Ancestors that bound a form region. Climbing past one would let a sweep on a
  // form-less page harvest unrelated site chrome.
  //
  // MAIN/ARTICLE/SECTION matter as much as NAV: on a typical SPA the only element
  // between a widget and <body> is the app root, so without them the climb
  // reaches the whole page and the "bounded" sweep is not bounded at all.
  function isLandmark(el) {
    if (!el || el.nodeType !== 1) return true;
    if (/^(NAV|HEADER|FOOTER|ASIDE|MAIN|ARTICLE|SECTION|DIALOG)$/.test(el.tagName)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    return /^(banner|navigation|contentinfo|search|main|region|complementary|article|dialog|feed|list)$/.test(role);
  }

  // How far the climb may travel from the fields actually touched. A form's
  // fields sit within a few levels of each other; anything further is page
  // structure, not the form.
  const MAX_CLIMB = 5;

  // Lowest common ancestor of a set of same-root elements, or null if they span
  // roots (a shadow boundary) — the caller then falls back safely.
  function lca(elements) {
    const live = [...elements].filter((e) => e.isConnected);
    if (!live.length) return null;
    let ancestor = live[0];
    for (const el of live.slice(1)) {
      while (ancestor && !ancestor.contains(el)) ancestor = ancestor.parentElement;
      if (!ancestor) return null;
    }
    return ancestor;
  }

  /**
   * The region a scope's sweep is allowed to walk. A <form> is its own boundary.
   * A form-less scope is bounded by climbing from the armed fields' common
   * ancestor up to — but not past — the nearest landmark. This is what stops one
   * comment box from arming a sweep of an entire media page.
   */
  function computeSweepRoot(scopeKey) {
    const set = scopeFields.get(scopeKey);
    if (!set || !set.size) return null;

    if (scopeKey.startsWith("form:")) {
      const anchor = [...set].find((e) => e.isConnected);
      if (anchor) return anchor.closest(SCOPE_SELECTOR);
      // Every recorded node is stale — a wizard replaced the form between steps.
      // Re-resolve by position so prefilled values on the new render are still
      // recovered instead of the scope going permanently blind.
      const index = Number(scopeKey.slice("form:".length));
      const forms = document.querySelectorAll(SCOPE_SELECTOR);
      return forms[index] || null;
    }

    const root0 = lca(set);
    // No common ancestor: everything is detached, or the fields span a shadow
    // boundary. Sweeping document.body here would restore the page-wide harvest
    // precisely when the page is most volatile — skip this scope instead.
    if (!root0) return null;

    let root = root0;
    for (let i = 0; i < MAX_CLIMB; i++) {
      const parent = root.parentElement;
      if (!parent || parent.tagName === "BODY" || isLandmark(parent)) break;
      root = parent;
    }
    return root;
  }

  /**
   * Recover fields the user never touched — prefilled values (LinkedIn Easy Apply
   * fills name/email/phone from your profile) and controls whose events never
   * reached us (a `change` from inside a shadow root is not composed).
   *
   * Bounded to each scope's region, never the whole document: the old page-wide
   * sweep is what turned one media-page interaction into a harvest of everything.
   */
  function sweep() {
    for (const [scopeKey, draft] of drafts) {
      let root;
      try {
        root = computeSweepRoot(scopeKey);
      } catch {
        root = null;
      }
      if (!root) continue;
      for (const el of allFields(root)) {
        const kind = resolver.classify(el);
        if (kind === "excluded") {
          if (resolver.isAuthField(el)) authScopes.add(scopeKey);
          continue;
        }
        // A disabled field is not even submitted by the site, so archiving it
        // would hold data the site itself never received.
        if (el.disabled) continue;
        // A form nested inside this region belongs to its own scope.
        if (scopeKeyFor(el) !== scopeKey) continue;
        const value = collect.readValue(el);
        if (value === "" || value === false) continue;
        if (kind === "text" || kind === "choice") recordField(scopeKey, el);
        collect.upsertField(draft, resolver.describeField(el), value, elementId(el), now());
      }
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush("draft");
    }, FLUSH_DEBOUNCE_MS);
  }

  function signatureFor(draft) {
    const fields = Object.values(draft.fields).map((f) => ({
      label: f.label,
      confidence: f.confidence,
    }));
    return resolver.computeSignature(fields, location);
  }

  /**
   * Status has precedence, it is not simply the latest event: a submitted
   * application must not be relabelled "abandoned" merely because the tab was
   * closed afterwards. Only an explicit rejection (force) walks it back.
   */
  function flush(status, { force = false, only = null } = {}) {
    if (!drafts.size) return;
    // Nothing is written before a submit, so until one happens there is no point
    // sweeping or serialising. Drafts still accumulate in memory meanwhile.
    if (!submitScopes.size && !sentIds.size) return;
    sweep();
    for (const [scopeKey, draft] of drafts) {
      // A status belongs to the scope that produced it. Without this, submitting
      // one form marked every other draft on the page as submitted — and a
      // rejected submit elsewhere walked a finished application back to draft.
      const owns = only === null || only === scopeKey;

      // The gate: is this a form, or media/social noise? A single volume slider,
      // a like toggle, or a lone search box never gets this far.
      const sawAuth = authScopes.has(scopeKey);
      const submit = submitScopes.has(scopeKey);
      const qualifies =
        !collect.isEmpty(draft) && collect.isFormLike(draft, { sawAuth, submit });

      if (!qualifies) {
        // A record that no longer qualifies — the user cleared their answers, or
        // deleted enough of them that this is no longer a form — must not be left
        // behind on disk. Deleting text has to delete it from the archive too.
        if (sentIds.has(draft.id)) {
          sentIds.delete(draft.id);
          log(`removing record that no longer qualifies (${scopeKey})`);
          post({ type: "submission/delete", id: draft.id });
        }
        continue;
      }

      if (owns && (force || draft.status !== "submitted")) draft.status = status;
      draft.formSignature = signatureFor(draft);
      const submission = collect.toSubmission(draft, draft.status, now());
      log(`flush ${submission.status}`, submission.fields.length, "fields", submission.fields.map((f) => f.label));
      sentIds.add(draft.id);
      // Upserts are idempotent on the draft id, so a service worker that dies
      // mid-flight costs at most the latest delta.
      post({ type: "submission/put", submission });
    }
  }

  /**
   * Send to the background, surfacing failures. A rejected send is the difference
   * between "nothing was typed" and "the record never arrived" — never swallow it.
   */
  function post(message) {
    try {
      const p = api.runtime.sendMessage(message);
      if (p && typeof p.catch === "function") {
        p.catch((err) => console.warn("[formistory] background did not accept the record:", err));
      }
    } catch (err) {
      console.warn("[formistory] could not reach the background:", err);
    }
  }

  /**
   * @param status  status to record
   * @param clear   drop the drafts afterwards. Only true when we have genuinely
   *                moved on (a new page / route), never after a submit click:
   *                clearing there meant a rejected submission started a fresh
   *                draft, so every retry wrote another copy of the application.
   */
  function finalize(status, clear = false, only = null) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush(status, { only });
    if (clear) {
      // Reset all per-scope state together, so a reused scope key (e.g. "page"
      // after an SPA route change) does not inherit the previous page's flags.
      drafts.clear();
      scopeFields.clear();
      authScopes.clear();
      submitScopes.clear();
    }
  }

  /**
   * Did this submit actually go through?
   *
   * A click on "Submit" is an *attempt*, not an outcome — a missed mandatory
   * field or a rejected value leaves you on the same form. Recording those as
   * submitted turns one application into a pile of half-finished duplicates.
   * Native constraint validation answers immediately; custom validation only
   * shows up once the page has re-rendered, so it is re-checked shortly after.
   */
  function submissionRejected(el) {
    const form = el && el.closest && el.closest("form");
    if (form && typeof form.checkValidity === "function" && !form.checkValidity()) return true;
    // Scope the error search to this form's region. Searching the whole document
    // meant one stray aria-invalid anywhere on a form-less page (Ashby, Workday,
    // LinkedIn — the primary targets) permanently suppressed submit detection.
    const scope = form || computeSweepRoot(scopeKeyFor(el));
    if (!scope) return false;
    return !!scope.querySelector('[aria-invalid="true"], [aria-errormessage]');
  }

  /* ---------- listeners ---------- */

  // Capture phase so a page calling stopPropagation cannot hide input from us.
  // 'change' is what catches selects, checkboxes and radios.
  // composedPath()[0] rather than e.target: an event crossing a shadow boundary
  // retargets to the host, which is not a form control, so the real field would
  // be silently ignored.
  for (const type of ["input", "change", "focusout"]) {
    document.addEventListener(
      type,
      (e) => {
        const path = typeof e.composedPath === "function" ? e.composedPath() : null;
        handleElement((path && path[0]) || e.target);
      },
      { capture: true, passive: true }
    );
  }

  /**
   * Which draft does this submit belong to?
   *
   * Not simply the control's own scope: modal wizards and sticky footers put the
   * Submit button *outside* the <form> it submits, which would attribute it to
   * the page bucket and leave the real draft unfinished. Falls back to the only
   * open draft, and to "all" when genuinely ambiguous.
   */
  function submitScopeFor(node) {
    if (!node || !node.matches) return null;
    const key = scopeKeyFor(node);
    if (drafts.has(key)) return key;
    if (drafts.size === 1) return [...drafts.keys()][0];
    return null;
  }

  function markSubmit(node) {
    const key = submitScopeFor(node);
    if (key) submitScopes.add(key);
    else for (const k of drafts.keys()) submitScopes.add(k);
  }

  // A native submit event only fires once constraint validation has passed, so
  // this one is trustworthy on its own. Drafts are kept, not cleared: an AJAX
  // form that is rejected server-side should update this record, not add another.
  document.addEventListener(
    "submit",
    (e) => {
      markSubmit(e.target);
      finalize("submitted", false, submitScopeFor(e.target));
    },
    { capture: true }
  );

  // Multi-step applications are the norm, not the exception: Workday's is eight
  // steps and LinkedIn Easy Apply is a paged modal. Advancing a step must NOT
  // finalise, or one application is stored as N separate completed documents.
  const ADVANCE = /\b(next|continue|review|save and continue|back)\b/;
  const FINAL = /\b(submit|send application|finish|done|apply now)\b/;

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target && e.target.closest && e.target.closest("button, [type=submit], [role=button]");
      if (!el) return;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`
        .toLowerCase()
        .replace(/\s+/g, " ");

      // Let the click's own handlers run first, then record the values they saw.
      if (FINAL.test(text) || el.type === "submit") {
        markSubmit(el);
        const scope = submitScopeFor(el);
        setTimeout(() => finalize(submissionRejected(el) ? "draft" : "submitted", false, scope), 0);
        // Custom validation renders after the click, so confirm once the page has
        // settled and downgrade *this* form's record if it pushed back.
        setTimeout(() => {
          if (el.isConnected && submissionRejected(el)) flush("draft", { force: true, only: scope });
        }, 1500);
      } else if (ADVANCE.test(text)) {
        // Persist progress but keep the draft open across the step boundary.
        setTimeout(() => flush("draft"), 0);
      }
    },
    { capture: true, passive: true }
  );

  // Anything unsent when the page goes away is kept rather than dropped, but only
  // downgraded to "abandoned" if it was never submitted — a completed application
  // must not be relabelled just because the tab closed afterwards.
  window.addEventListener("pagehide", () => finalize("abandoned", true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush("draft");
  });

  // SPA route changes. history.pushState cannot be patched from the isolated
  // world (the page's calls would not reach our override), so poll instead.
  // Compares path only: LinkedIn rewrites the query string constantly while you
  // browse, and treating that as navigation discarded drafts mid-application.
  function onRouteChange() {
    const path = location.origin + location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    finalize("abandoned", true);
  }
  window.addEventListener("popstate", onRouteChange);
  setInterval(onRouteChange, 1000);
})();
