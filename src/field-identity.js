/**
 * Field identity resolver — turns a form control into a human-readable label and
 * a form into a signature that survives revisits.
 *
 * Runs in three places, dependency-free:
 *   • as a content script inside the extension (primary)
 *   • pasted into a DevTools console, where it auto-runs a coverage report
 *   • require()d from a Node test under jsdom
 *
 * Measured 100% label coverage on Greenhouse, Lever, Ashby, Google Forms, Tally
 * and plain HTML forms. See spike/README.md for the numbers and the nine bugs
 * that real forms caught.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.__formSpike = api;
  // Content-script files share one isolated-world scope; capture.js reads the
  // resolver off this namespace rather than a bare global.
  root.FA = root.FA || {};
  root.FA.resolver = api;
  // Auto-run the console report only when pasted into a page by hand — never
  // inside the extension, where it would spam every tab's console.
  const hasDom = typeof window !== "undefined" && typeof document !== "undefined";
  const inExtension = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  if (hasDom && !inExtension && !root.__FORM_SPIKE_NO_AUTORUN) api.report();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NATIVE_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
  // Google Forms renders every choice as a <div role="radio">, not a native input.
  // Without these, a 30-question Google Form yields only its handful of text boxes.
  const ARIA_SELECTOR =
    "[role=radio], [role=checkbox], [role=switch], [role=textbox], [role=combobox], [role=listbox], [role=spinbutton], [role=slider]";
  const FIELD_SELECTOR = `${NATIVE_SELECTOR}, ${ARIA_SELECTOR}`;

  // "Passenger" controls: real UI, never a form *answer*. A volume slider, a
  // theme colour picker, a like/follow toggle. They are stored only when the
  // surrounding page is already a form, and they can never make a page look like
  // one. This is the core of the media-site fix — a YouTube volume drag matches
  // FIELD_SELECTOR but must never manufacture a record.
  const PASSENGER_TYPES = new Set(["range", "color", "slider", "switch", "spinbutton", "listbox"]);

  // Exact-token search identifiers. A substring test is a trap: it matches
  // `s-name`, `s-ssn` (regex `\b` treats `-` as a boundary) and the `'s` in
  // "It's", which would delete real application fields.
  const SEARCH_TOKENS = new Set([
    "q", "s", "query", "search", "searchterm", "search_query", "keyword", "keywords", "term",
  ]);

  function fieldType(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") return (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "textarea" || tag === "select") return tag;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (role) return role;
    // A contenteditable host reports its tag name ("div") otherwise, so nothing
    // downstream could tell prose editors apart from anything else.
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    if (ce === "" || ce === "true" || el.isContentEditable) return "contenteditable";
    return tag;
  }

  // Mirrors the hard exclusions from the plan. Anything matching here is never
  // captured and never counted in the coverage stats.
  // `file` is deliberately absent: the *filename* ("resume-v3.pdf") is worth
  // keeping on a job application, and it is not the file's contents.
  const EXCLUDED_INPUT_TYPES = new Set(["password", "hidden", "submit", "button", "reset", "image"]);
  const EXCLUDED_AUTOCOMPLETE = new Set([
    "current-password", "new-password", "one-time-code",
    "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc",
    "cc-name", "cc-given-name", "cc-additional-name", "cc-family-name", "cc-type",
  ]);

  // Anti-bot and framework tokens. Never user-authored, and they surface as
  // visible textareas — real Ashby forms carry a g-recaptcha-response field.
  const EXCLUDED_NAME_PATTERN =
    /(recaptcha|h-captcha|turnstile|csrf|xsrf|authenticity_token|verificationtoken|__viewstate)/i;

  // Confidence per resolution rule. The 0.5 line is the "is this actually readable
  // by a human" threshold — below it we've fallen back to machine identifiers.
  const RULES = {
    LABEL_FOR: 1.0,
    LABEL_WRAPPING: 0.95,
    ARIA_LABELLEDBY: 0.9,
    ARIA_LABEL: 0.85,
    LEGEND: 0.75,
    GROUP_TEXT: 0.7,
    PLACEHOLDER: 0.6,
    CONTAINER_TEXT: 0.5,
    HUMANIZED_NAME: 0.3,
    NONE: 0.0,
  };
  const READABLE_THRESHOLD = 0.5;

  /* ---------- DOM traversal (pierces open shadow roots) ---------- */

  function* walkElements(node) {
    let nodes;
    try {
      nodes = node.querySelectorAll("*");
    } catch {
      return;
    }
    for (const el of nodes) {
      yield el;
      if (el.shadowRoot) yield* walkElements(el.shadowRoot);
    }
  }

  function collectRoots(doc) {
    const roots = [{ root: doc, frame: "top" }];
    for (const iframe of doc.querySelectorAll("iframe")) {
      try {
        // Throws on cross-origin. Those frames need their own content script at
        // runtime (all_frames: true); nothing to do about them from the console.
        const inner = iframe.contentDocument;
        if (inner) roots.push({ root: inner, frame: iframe.src || "(inline iframe)" });
        else roots.push({ root: null, frame: iframe.src || "(cross-origin)", blocked: true });
      } catch {
        roots.push({ root: null, frame: iframe.src || "(cross-origin)", blocked: true });
      }
    }
    return roots;
  }

  // jsdom has no layout engine, so getClientRects() is always empty there. Tests
  // pass checkVisibility:false; real browsers keep the check on.
  function isVisible(el) {
    if (typeof el.getClientRects === "function" && el.getClientRects().length === 0) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return true;
    const style = view.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // Credential-ish identifiers. A "show password" toggle flips type=password to
  // type=text, so type alone is not a reliable signal — see wasEverPassword.
  const SECRET_NAME_PATTERN = /(^|[-_.])(pass|passwd|password|pwd|passphrase|otp|totp|mfa|2fa)([-_.]|$)/i;

  // Any element ever seen as a password field stays excluded for the life of the
  // page, even after a "show password" toggle rewrites it to type=text. Without
  // this, clicking the eye icon writes a labelled plaintext credential to disk.
  const everPassword = new WeakSet();

  function isExcluded(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.type || "").toLowerCase() === "password") {
      everPassword.add(el);
      return true;
    }
    if (everPassword.has(el)) return true;
    if (tag === "input" && EXCLUDED_INPUT_TYPES.has((el.type || "").toLowerCase())) return true;
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.some((t) => EXCLUDED_AUTOCOMPLETE.has(t))) return true;
    const ident = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`;
    if (EXCLUDED_NAME_PATTERN.test(ident)) return true;
    // A field named like a secret is never archived, whatever its current type.
    return SECRET_NAME_PATTERN.test(ident);
  }

  // A password / OTP field. Excluded from storage, but its presence marks the
  // scope as an auth form so the gate can reject logins and signups that would
  // otherwise clear the field-count bar.
  function isAuthField(el) {
    if (el.tagName.toLowerCase() === "input" && (el.type || "").toLowerCase() === "password") return true;
    if (everPassword.has(el)) return true;
    const tokens = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (tokens.includes("current-password") || tokens.includes("new-password")) return true;
    if (tokens.includes("one-time-code")) return true;
    const ident = `${el.getAttribute("name") || ""} ${el.getAttribute("id") || ""}`;
    return SECRET_NAME_PATTERN.test(ident);
  }

  // A site-search / filter box. Detected structurally first, then by exact-token
  // name/id, then by a leading "search" in prose attributes. Never a substring
  // match. Whether a search field is actually dropped is a scope decision made in
  // the capture gate (a lone search box is noise; a `name="s"` inside a real form
  // is kept), so this only reports the classification.
  function isSearchField(el) {
    const type = fieldType(el);
    if (type === "search" || type === "searchbox") return true;
    if (el.closest && el.closest("[role=search]")) return true;
    for (const attr of ["name", "id"]) {
      const raw = (el.getAttribute(attr) || "").trim().toLowerCase();
      if (!raw) continue;
      if (SEARCH_TOKENS.has(raw)) return true;
      if (raw.split(/[-_.]/)[0] === "search") return true;
    }
    const aria = el.getAttribute("aria-label") || "";
    const ph = el.getAttribute("placeholder") || "";
    return /^\s*search\b/i.test(aria) || /^\s*search\b/i.test(ph);
  }

  // Picking from a list the site wrote is not the same as composing an answer.
  // A product page's colour and model dropdowns are <select>s, as are "Size" and
  // "Quantity" — data, but never the thing that makes a page worth archiving.
  const CHOICE_INPUT_TYPES = new Set(["radio", "checkbox", "switch", "select"]);

  // Structured values picked rather than written.
  const PICKER_INPUT_TYPES = new Set([
    "number", "date", "time", "datetime-local", "month", "week", "file",
  ]);

  /**
   * Sort a control into one class. The capture gate is a pure function of these:
   *   excluded  — never stored (passwords, payment, bot tokens)
   *   passenger — UI, not an answer (volume, colour picker, like toggle); stored
   *               only if the scope already qualifies, never counts toward the gate
   *   search    — a search box; kept only among other data fields
   *   choice    — one of a fixed set the site offered (radio, checkbox, select)
   *   picker    — a structured value (number, date, file)
   *   text      — prose the user actually composed. This is the class that
   *               decides whether a page is a form worth keeping.
   */
  function classify(el) {
    if (isExcluded(el)) return "excluded";
    const type = fieldType(el);
    if (PASSENGER_TYPES.has(type)) return "passenger";
    if (isSearchField(el)) return "search";
    if (CHOICE_INPUT_TYPES.has(type)) return "choice";
    if (PICKER_INPUT_TYPES.has(type)) return "picker";
    return "text";
  }

  // A placeholder is only a label when it names the field. Format hints and
  // example values name nothing — Ashby ships "Type here...", "Start typing...",
  // "hello@example.com...", "1-415-555-1234..." across every input.
  const GENERIC_PLACEHOLDER =
    /^(type here|start typing|type to search|select|choose|search|enter|pick|none|n\/a|optional|required)\b/i;

  function isUsefulPlaceholder(text) {
    const t = text.replace(/\.{2,}\s*$/, "").trim();
    if (t.length < 3) return false;
    if (GENERIC_PLACEHOLDER.test(t)) return false;
    if (/^e\.?g\.?[\s:.]/i.test(t)) return false; // "e.g. Acme Inc"
    if (/@/.test(t)) return false; // hello@example.com
    if (/^[\d\s()+\-.\/]{6,}$/.test(t)) return false; // 1-415-555-1234
    if (/^[mdyhs]+[\/\-.\s][mdyhs\/\-.\s]*$/i.test(t)) return false; // MM/DD/YYYY
    return true;
  }

  /* ---------- label resolution ---------- */

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 200);

  // Elements whose textContent is code, not prose. Real Greenhouse forms inline
  // <style> blocks between fields, and reading one as a label yields a CSS rule
  // that scores as confidently resolved.
  const NON_TEXT_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "SVG"]);

  // Choice-group questions may run long; a lone field's guessed label may not.
  const GROUP_TEXT_MAX = 300;

  // Site furniture: never a question, however close it sits to a field.
  const CHROME_TAGS = /^(NAV|HEADER|FOOTER|ASIDE|MENU)$/;
  const CHROME_ROLES = /^(navigation|banner|contentinfo|menubar|toolbar|tablist|search)$/;

  // Text of an element minus any nested form control, so a wrapping <label>
  // doesn't swallow the input it wraps.
  function ownText(el) {
    if (NON_TEXT_TAGS.has(el.tagName)) return "";
    // An aria-hidden element is decorative by definition — a required-marker glyph
    // or an icon. Stripping only its descendants left "★" scoring as a real label.
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll(FIELD_SELECTOR).forEach((n) => n.remove());
    clone.querySelectorAll("style, script, noscript, template").forEach((n) => n.remove());
    // Collapsed dropdown state and screen-reader-only chatter. Lever's location
    // combobox hides "No location found. Try entering a different location" and
    // "Loading" inside the same <label> as the question.
    clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach((n) => n.remove());
    return clean(clone.textContent);
  }

  // Only the text preceding the control inside a wrapping <label> names it.
  // Lever puts "Current location ✱" before its combobox and the dropdown's
  // "No location found…/Loading" state after it, inside the same label.
  function textBeforeControl(labelEl, controlEl) {
    let out = "";
    for (const node of labelEl.childNodes) {
      if (node.nodeType === 1) {
        if (node === controlEl || node.contains(controlEl)) break;
        out += " " + ownText(node);
      } else if (node.nodeType === 3) {
        out += " " + node.textContent;
      }
    }
    return clean(out);
  }

  function escapeId(id, view) {
    if (view && view.CSS && typeof view.CSS.escape === "function") return view.CSS.escape(id);
    // Workday/Ashby ids routinely contain --, $ and :.
    return id.replace(/["\\]/g, "\\$&");
  }

  function resolveLabelledBy(el, searchRoot, view) {
    const refs = el.getAttribute("aria-labelledby");
    if (!refs) return "";
    const parts = refs
      .split(/\s+/)
      .map((ref) => {
        try {
          if (typeof searchRoot.getElementById === "function") return searchRoot.getElementById(ref);
          return searchRoot.querySelector(`#${escapeId(ref, view)}`);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .map(ownText)
      .filter(Boolean);
    return parts.length ? clean(parts.join(" ")) : "";
  }

  function resolveLabel(el, scope) {
    const doc = el.ownerDocument;
    const view = doc && doc.defaultView;
    // Shadow roots resolve label[for] and getElementById against themselves.
    const searchRoot = scope || el.getRootNode();

    // Try id first, then name: Ashby points label[for] at the field's *name*
    // (a UUID) on controls that carry no id at all.
    for (const key of [el.getAttribute("id"), el.getAttribute("name")]) {
      if (!key) continue;
      let forLabel = null;
      try {
        forLabel = searchRoot.querySelector(`label[for="${escapeId(key, view)}"]`);
      } catch {
        continue; // malformed identifier
      }
      if (forLabel) {
        const t = ownText(forLabel);
        if (t) return { label: t, source: "LABEL_FOR" };
      }
    }

    const wrapping = el.closest("label");
    if (wrapping) {
      const t = textBeforeControl(wrapping, el) || ownText(wrapping);
      if (t) return { label: t, source: "LABEL_WRAPPING" };
    }

    const labelledByText = resolveLabelledBy(el, searchRoot, view);
    if (labelledByText) return { label: labelledByText, source: "ARIA_LABELLEDBY" };

    const ariaLabel = clean(el.getAttribute("aria-label"));
    if (ariaLabel) return { label: ariaLabel, source: "ARIA_LABEL" };

    const fieldset = el.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) {
        const t = ownText(legend);
        if (t) return { label: t, source: "LEGEND" };
      }
    }

    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder && isUsefulPlaceholder(placeholder)) {
      return { label: placeholder, source: "PLACEHOLDER" };
    }

    const nearby = nearestPrecedingText(el);
    if (nearby) return { label: nearby, source: "CONTAINER_TEXT" };

    const name = el.getAttribute("name") || el.getAttribute("id");
    if (name) return { label: humanize(name), source: "HUMANIZED_NAME" };

    return { label: "", source: "NONE" };
  }

  // Climb ancestors looking for the closest text that reads like a question.
  // This is what rescues the "no label, no aria, no placeholder" ATS widgets.
  /**
   * Is this text several page elements glued together rather than one question?
   *
   * Length is a poor discriminator — real questions run long ("This is a hybrid
   * role, working out of our Boston, MA office 4 days per week. Does that
   * work for you?"). The reliable tell is the seam left where adjacent elements
   * were concatenated: "LocationSan Francisco, CAEmployment TypeFull time".
   * One such seam is normal in prose ("LinkedIn URL", "GitHub Profile"); several
   * mean the text was assembled, not written.
   */
  function isConcatenatedBlock(text) {
    return (text.match(/[a-z][A-Z]/g) || []).length >= 2;
  }

  // maxLen differs by caller. For a lone unlabelled field this rule is pure
  // guesswork and an over-long hit is page content, so it is capped tightly. For
  // a choice group the surrounding structure already confirms a question exists,
  // and real questions run long ("This is a hybrid role… Does that work for you?").
  function nearestPrecedingText(el, maxLen = 250) {
    let node = el;
    for (let depth = 0; depth < 5 && node; depth++) {
      let sib = node.previousElementSibling;
      while (sib) {
        // Stop at the first control: text lying beyond another field belongs to
        // that field, not to this one. Without this, an unlabelled input silently
        // inherits the previous question's text.
        if (sib.matches(FIELD_SELECTOR) || sib.querySelector(FIELD_SELECTOR)) break;
        // Page furniture is not a question. Ashby's unlabelled resume dropzone
        // otherwise picked up the nav breadcrumb and stored "OverviewApplication".
        if (CHROME_TAGS.test(sib.tagName) || CHROME_ROLES.test(sib.getAttribute("role") || "")) {
          sib = sib.previousElementSibling;
          continue;
        }
        const t = ownText(sib);
        if (t && t.length > 1 && t.length <= maxLen && !isConcatenatedBlock(t)) return t;
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
      if (node && /^(form|body|html)$/i.test(node.tagName)) break;
    }
    return "";
  }

  // Radio and checkbox groups: the wrapping <label> names the *option* ("Yes"),
  // not the question. A submission read as a document needs the question as the
  // label and the chosen option as the value, so the group is resolved separately.
  //
  // Lever's shape, which this targets:
  //   <div class="application-label"><div class="text">Are you authorized…</div></div>
  //   <div class="application-field"><ul><li><label><input type=radio value="Yes">…
  // Distinguishes "this control's label names the OPTION" from "…names the QUESTION".
  // Only the former should be replaced by its group's question. Ashby labels a lone
  // checkbox with the question itself via label[for], and promoting a group label
  // there would overwrite a correct label with a section heading.
  function looksLikeOption(el, label) {
    if (!label) return false;
    if (el.hasAttribute("data-value")) return true; // Google Forms options
    const aria = clean(el.getAttribute("aria-label"));
    if (aria && aria === label) return true;
    const value = clean(el.getAttribute("value"));
    if (value && value === label) return true; // Lever: value="Yes", label "Yes"
    return false;
  }

  function resolveGroupLabel(el, searchRoot) {
    const view = el.ownerDocument && el.ownerDocument.defaultView;

    // ARIA choice groups: climb to the nearest labelled ancestor that contains
    // choice widgets. Deliberately not a fixed role list — Google Forms uses
    // role="radiogroup" for radios but role="list" for checkbox groups, and both
    // carry the question via aria-labelledby.
    const CHOICES = "[role=radio], [role=checkbox], [role=switch], input[type=radio], input[type=checkbox]";
    let anc = el.parentElement;
    for (let depth = 0; anc && depth < 8; depth++, anc = anc.parentElement) {
      if (/^(form|body|html)$/i.test(anc.tagName)) break;
      if (!anc.hasAttribute("aria-labelledby") && !anc.hasAttribute("aria-label")) continue;
      if (!anc.querySelector(CHOICES)) continue;
      const t = resolveLabelledBy(anc, searchRoot, view) || clean(anc.getAttribute("aria-label"));
      if (t) return { label: t, source: "GROUP_TEXT" };
    }

    const name = el.getAttribute("name");
    if (!name) return null;

    let peers;
    try {
      peers = Array.from(searchRoot.querySelectorAll(`input[name="${escapeId(name, view)}"]`));
    } catch {
      return null;
    }
    if (peers.length < 2) return null;

    let ancestor = el.parentElement;
    while (ancestor && !peers.every((p) => ancestor.contains(p))) ancestor = ancestor.parentElement;
    if (!ancestor) return null;

    const fieldset = ancestor.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) {
        const t = ownText(legend);
        if (t) return { label: t, source: "LEGEND" };
      }
    }
    const t = nearestPrecedingText(ancestor, GROUP_TEXT_MAX);
    return t ? { label: t, source: "GROUP_TEXT" } : null;
  }

  function humanize(raw) {
    return clean(
      raw
        .replace(/[_\-.[\]$:]+/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
    );
  }

  /* ---------- form signature ---------- */

  // Strip volatile path segments so /jobs/8f3a-.../apply and /jobs/91b2-.../apply
  // are recognised as the same form shape across visits.
  function normalizePath(pathname) {
    return pathname
      .split("/")
      .map((seg) => {
        if (/^\d+$/.test(seg)) return ":num";
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
        if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hex";
        if (/^\d[\w-]{6,}$/.test(seg)) return ":id";
        return seg;
      })
      .join("/");
  }

  // FNV-1a. Not cryptographic — this is an identity key, not a security boundary.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function computeSignature(fields, location) {
    // Sorted labels only: field order and late-injected fields shouldn't break
    // identity, and DOM position deliberately plays no part (that's how the
    // position-keyed incumbents broke across redeploys).
    const basis = fields
      .filter((f) => f.confidence >= READABLE_THRESHOLD)
      .map((f) => f.label.toLowerCase())
      .sort()
      .join("|");
    return `${location.origin}${normalizePath(location.pathname)}#${hash(basis)}`;
  }

  /* ---------- collection ---------- */

  /**
   * Describe a single control. Extracted from collectFields so the capture
   * pipeline can resolve one element on an input event without rescanning the
   * whole document on every keystroke.
   */
  function describeField(el) {
    const scope = el.getRootNode();
    const type = fieldType(el);
    let { label, source } = resolveLabel(el, scope);
    let optionLabel = "";

    if (type === "radio" || type === "checkbox" || type === "switch") {
      // Name the option first, and independently of whether the group label gets
      // promoted. Two options that end up sharing a name collapse into one entry,
      // so unchecking either would wipe the other's answer.
      optionLabel = clean(
        el.getAttribute("value") || el.getAttribute("data-value") || el.getAttribute("aria-label") || ""
      );
      if (optionLabel === "__other_option__") optionLabel = "Other";

      // When the control's own label names the OPTION, the question lives on the
      // group — promote it so the stored field reads as a question and an answer.
      if (looksLikeOption(el, label)) {
        const group = resolveGroupLabel(el, scope);
        if (group) {
          if (!optionLabel) optionLabel = label;
          label = group.label;
          source = group.source;
        }
      }
    }

    // A rule can fire on markup that cleans down to nothing (a label holding only
    // an icon or a zero-width character). An empty label is not a label, and must
    // never be counted as resolved.
    if (!label) source = "NONE";

    return {
      label,
      labelSource: source,
      confidence: RULES[source],
      optionLabel,
      inputType: type,
      kind: classify(el),
      name: el.getAttribute("name") || "",
      domId: el.getAttribute("id") || "",
    };
  }

  function collectFields(doc, options) {
    const opts = Object.assign({ checkVisibility: true }, options);
    const fields = [];
    const skipped = { excluded: 0, invisible: 0 };
    const blockedFrames = [];

    for (const { root, frame, blocked } of collectRoots(doc)) {
      if (blocked) {
        blockedFrames.push(frame);
        continue;
      }
      for (const el of walkElements(root)) {
        if (!el.matches || !el.matches(FIELD_SELECTOR)) continue;
        if (isExcluded(el)) {
          skipped.excluded++;
          continue;
        }
        if (opts.checkVisibility && !isVisible(el)) {
          skipped.invisible++;
          continue;
        }

        fields.push(Object.assign(describeField(el), { order: fields.length, frame }));
      }
    }
    return { fields, skipped, blockedFrames };
  }

  function analyze(doc, location, options) {
    const { fields, skipped, blockedFrames } = collectFields(doc, options);
    const readable = fields.filter((f) => f.confidence >= READABLE_THRESHOLD);
    const bySource = {};
    for (const f of fields) bySource[f.labelSource] = (bySource[f.labelSource] || 0) + 1;

    return {
      url: location.href,
      signature: computeSignature(fields, location),
      totalFields: fields.length,
      readableFields: readable.length,
      coveragePct: fields.length ? Number(((readable.length / fields.length) * 100).toFixed(1)) : 0,
      bySource,
      skipped,
      blockedFrames,
      fields,
    };
  }

  /* ---------- console report ---------- */

  function report() {
    const result = analyze(document, window.location);
    const ok = result.coveragePct >= 80;

    console.group(`%cfield-identity spike — ${location.hostname}`, "font-weight:bold;font-size:13px");
    console.table(
      result.fields.map(({ order, label, labelSource, confidence, inputType, name }) => ({
        order, label, labelSource, confidence, inputType, name,
      }))
    );
    console.log("resolution rules used:", result.bySource);
    console.log("skipped:", result.skipped);
    console.log(`signature: ${result.signature}`);
    console.log(
      `%ccoverage: ${result.coveragePct}%  (${result.readableFields}/${result.totalFields} readable)  — gate is 80%`,
      `font-weight:bold;color:${ok ? "#0a0" : "#c00"}`
    );
    if (result.blockedFrames.length) {
      console.warn(
        `${result.blockedFrames.length} cross-origin iframe(s) unreachable from the console. ` +
          `These need all_frames:true at runtime — not a resolver failure.`
      );
    }
    console.groupEnd();
    console.log(
      "%c__formSpike.last — .json() to export, .compare('<old sig>') on revisit",
      "color:#888"
    );

    module_state.last = result;
    return result;
  }

  const module_state = { last: null };

  return {
    // internals, exported for tests and for the capture pipeline
    resolveLabel, collectFields, analyze, computeSignature,
    normalizePath, humanize, hash, isExcluded, fieldType, describeField,
    classify, isAuthField, isSearchField,
    RULES, READABLE_THRESHOLD, FIELD_SELECTOR,
    // console entry points
    report,
    get last() {
      return module_state.last;
    },
    json() {
      return JSON.stringify(module_state.last, null, 2);
    },
    compare(previousSignature) {
      const now = module_state.last && module_state.last.signature;
      const same = previousSignature === now;
      console.log(
        `%csignature ${same ? "STABLE" : "DRIFTED"}\n  before: ${previousSignature}\n  now:    ${now}`,
        `font-weight:bold;color:${same ? "#0a0" : "#c00"}`
      );
      return same;
    },
  };
});
