# Phase 0 spike — field identity

Throwaway measurement, not extension code. It exists to answer the two questions that gate the
whole project **before** anything is built on top:

1. What fraction of fields resolve to a human-readable label? — **gate: ≥ 80%**
2. Is the form signature stable across separate visits? — **gate: identical**

Incumbent form-recovery extensions reportedly work on [~50% of sites](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/aoAIue0W47o)
because they key on `id`/`name` and fall over when neither exists. This measures whether a
label-first chain does meaningfully better.

## Status — gate cleared

`npm test` — **28/28 passing**.

| Target | Kind | Coverage | |
| --- | --- | --- | --- |
| Greenhouse — Anthropic | ATS, server-rendered | **100%** (7/7) | PASS |
| Lever — Whoop | ATS, server-rendered | **100%** (23/23) | PASS |
| Ashby — Ramp | ATS, client-rendered | **100%** (9/9) | PASS |
| Google Forms — live survey | ARIA widgets, client-rendered | **100%** (10/10) | PASS |
| Tally — contact template | form builder | **100%** (5/5) | PASS |
| httpbin | plain hand-written HTML | **100%** (12/12) | PASS |
| w3schools | plain HTML, partly unlabelled | 90% (18/20) | PASS |
| `fixture.html` | synthetic, deliberately hostile | 92.3% (12/13) | PASS |
| **Workday** | ATS behind auth | — | **NOT MEASURED** |
| **LinkedIn Easy Apply** | behind auth | — | **NOT MEASURED** |

The synthetic fixture scores *lowest* because it contains a field with no label of any kind, which
correctly refuses to resolve. Real forms label better than the worst case.

**Signature stability verified** by fetching the same form twice: identical on both Greenhouse and
Lever. Path normalization confirmed live — `/jobs/:num`, `/ramp/:uuid/application`,
`/whoop/:uuid/apply`.

### The biggest single find: Google Forms uses almost no native form controls

Choices are `<div role="radio">` and `<div role="checkbox">`, not inputs. A native
`input, textarea, select` selector sees **none** of them — on the surveyed form that is 16 radios
and 6 checkboxes invisible, leaving only 8 native text fields out of ~30 questions (**~27%**).

Adding ARIA widget roles to the selector took it to **100%**. Two details make it work:

- radios sit under `role="radiogroup"` but checkboxes under `role="list"` — **different roles**,
  both carrying the question via `aria-labelledby`. Group detection therefore climbs to the nearest
  *labelled ancestor containing choice widgets* rather than matching a fixed role list.
- the option value is in `data-value`, with `__other_option__` as a sentinel for the "Other:" row.

### Workday and LinkedIn are unmeasured, and that is a real residual risk

Workday's application form sits behind authentication. The apply route redirects to **Sign In**,
and the page announces `current step 1 of 8 … step 8 of 8` — the application is an **8-step wizard
whose first step is login**. Measuring it would require creating an account, which was out of
scope, so Workday's coverage is genuinely unknown rather than assumed-fine.

LinkedIn is the same category: an unauthenticated visit to its job search exposes **zero form
fields**, and Easy Apply never renders. Both need a signed-in field test during Phase 1.

Two consequences for the build:

- A Workday submission spans **eight route changes**, so the draft/finalize model must survive a
  long multi-step flow, not just one page.
- Workday uses no shadow DOM — plain DOM with `data-automation-id` — so the earlier assumption that
  it would need shadow-piercing was wrong. That part is cheaper than expected.

## Run it against a real form

```bash
node spike/serve.js
```

Then open a real application form (Workday, Greenhouse, Lever, Ashby), paste the whole of
`field-identity.js` into DevTools, and read the report. It prints a table of every field with the
rule that produced its label, the coverage percentage against the 80% gate, and a signature.

To test signature stability, revisit the same form later, paste again, and run:

```js
__formSpike.compare("<signature from the first visit>")
```

`__formSpike.json()` exports the full result if you want to diff two runs properly.

## How labels resolve

Tried in order; the rule that fires is recorded as `labelSource`, with a confidence score.
Anything below **0.5** counts as unreadable — that's the line between a real label and a machine
identifier.

| Rule | Confidence |
| --- | --- |
| `label[for=…]` | 1.00 |
| wrapping `<label>` | 0.95 |
| `aria-labelledby` (refs resolved and joined) | 0.90 |
| `aria-label` | 0.85 |
| `<fieldset><legend>` | 0.75 |
| `placeholder` | 0.60 |
| nearest preceding text in the container | 0.50 |
| humanized `name`/`id` | 0.30 |
| nothing | 0.00 |

The form signature is `origin` + normalized pathname + a hash of the **sorted** readable labels.
Sorting means field reordering and late-injected fields don't break identity; path normalization
collapses `/jobs/4f8a…/apply` and `/jobs/9c2b…/apply` to one form. DOM position deliberately plays
no part — position-keying is precisely how the incumbents break across redeploys.

## Files

- `field-identity.js` — the resolver. Dual-mode: auto-runs when pasted into a console, exports its
  internals when `require`d.
- `fixture.html` — synthetic form with the shapes that break naive resolvers: no `<form>`, fields
  with neither `id` nor `name`, shadow DOM, `contenteditable`, `fieldset`/`legend` radios, a field
  injected 100ms after parse, plus password/`cc-number`/hidden fields that must be excluded.
- `field-identity.test.js` — the gate, via jsdom.
- `serve.js` — static server for the fixture. Dev-only.

## Bugs the real forms caught

Every one of these produced a *confidently wrong* label — the dangerous failure mode, since coverage
still reported green. All are pinned by tests.

1. **Text stolen from the previous question.** `nearestPrecedingText` scanned all previous siblings,
   so an unlabelled field inherited the preceding field's text. Now stops at the first form control.
2. **CSS read as a label** *(live Greenhouse)*. Greenhouse inlines `<style>` between fields;
   `ownText` returned a CSS rule, which scored 0.5 and inflated coverage to a false 100%.
   `ownText` now refuses `<style>/<script>/<noscript>/<template>/<svg>`.
3. **`label[for]` pointing at a name, not an id** *(live Ashby)*. Ashby's Bay Area checkbox carries a
   UUID `name` and no `id`, with `label[for]` targeting the name. The resolver fell through and
   scraped a stray `<button>No</button>`, labelling the field **"No"**. Now tries `name` after `id`.
4. **Generic placeholders accepted as labels** *(live Ashby)*. The location combobox has no id and
   only `placeholder="Start typing..."`, which outranked the real question sitting one level up.
   Placeholders are now rejected when they're format hints or example values — `Type here...`,
   `Select...`, `hello@example.com`, `1-415-555-1234`, `MM/DD/YYYY`.
5. **Anti-bot tokens counted as user fields** *(live Ashby)*. A visible `g-recaptcha-response`
   textarea was being captured. Now excluded alongside csrf/xsrf/turnstile/viewstate.

6. **Radio groups labelled by their option, not their question** *(live Lever)*. The wrapping
   `<label>` around a radio names the option — so a submission stored as `"Yes": on` lost the
   question entirely. Choice groups now resolve the question from the group's common ancestor
   (`GROUP_TEXT`, or `LEGEND` for fieldsets) and keep the option in `optionLabel`.
7. **Dropdown state swallowed into a label** *(live Lever)*. The location combobox's `<label>` also
   contains `"No location found. Try entering a different location"` and `"Loading"`. Only text
   *preceding* the control inside a wrapping label is now treated as its label.

## What the real forms confirmed about the design

- **Ashby renders the form entirely client-side and has no `<form>` element at all.** Fetching the
  URL yields zero fields. This is direct evidence for the plan's decision not to hang capture off
  the `submit` event.
- **Ashby names its fields with UUIDs** (`eeea6952-8ba0-47ac-…`), which is precisely the case that
  breaks id/name-keyed incumbents — and precisely why identity is derived from labels here.
- **EEO self-identification is not hypothetical.** The live Lever form carries **Gender, Race and
  Veteran status** fields. That is GDPR Article 9 special-category data arriving through ordinary
  capture, which is what makes retention, redaction and a real delete path non-optional.

## Two things that must be decided before Phase 1

1. **Signatures are resolver-version-dependent.** The Greenhouse signature moved from `45f1878f` to
   `e0bb9a3d` purely because the label rules changed mid-spike. Any future resolver change
   invalidates continuity with already-stored submissions, so the stored record needs a
   `resolverVersion` and an upgrade path that recomputes signatures rather than orphaning history.
2. **A signature identifies a form *shape*, not a job.** Two different Anthropic postings produce
   the same signature, because the application form is identical. That is correct for "the same form
   across visits", but it means the viewer must group by URL and page title as well — the signature
   alone cannot tell two applications apart.
