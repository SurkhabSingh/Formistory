<div align="center">

<img src="icons/icon128.png" width="96" alt="Formistory">

# Formistory

**A private, local-only archive of the web forms you fill in — kept as readable documents.**

</div>

You apply for sixty jobs. Every one asks *"why do you want to work here?"*. You write sixty
thoughtful answers, and you keep none of them.

Formistory keeps them. It watches the forms you fill in and stores each submission as a document you
can read back — the question, then your answer, in the order the form asked:

> **Backend Engineer — Acme** · 3 March · submitted
> **Full name** — Ada Lovelace
> **Why do you want to work here?** — Because the hardest part of the problem is the part nobody has written down yet…
> **Are you legally authorized to work in the US?** — Yes

Nothing is transmitted. There is no server, no account, no telemetry, and no network code in the
extension at all.

---

## Install

Not on any extension store — install it from source.

**Chrome / Edge / Brave** — `chrome://extensions` → enable *Developer mode* → *Load unpacked* → pick this folder.
**Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → pick `manifest.json`.

Fill in any form, then click the toolbar icon → **Open archive**.

## Reading your archive

The viewer lists submissions by day and renders each as a document. Search runs across every
question and answer and highlights matches in place.

It **updates live** — leave it open in a tab and fill in a form elsewhere; the record appears as you
type. Export writes the whole archive as JSON. Deletion is per-record or all at once.

## What counts as a form

The hard part isn't capturing text — it's *not* capturing everything else. Changing the volume on
YouTube, liking a video, or typing in a search box are all "input events" too, and a naive version
of this tool archives them.

So capture is gated:

- **Controls are classified.** A volume slider, colour picker or like/follow toggle is a
  *passenger* — recorded only if the surrounding page is already a form, and never able to make a
  page look like one. A lone search box is ignored.
- **Two filled answer fields minimum** (or one, plus an explicit Submit) before anything is stored.
- **The sweep is bounded** to the form's own region, so touching one form can't drag in unrelated
  controls elsewhere on the page.
- **Auth forms are skipped.** A login or signup — an email and a password, with nothing
  application-shaped about it — is never archived.

## What is never stored

| Never captured at all | Captured, but value redacted |
| --- | --- |
| Password fields — including after a "show password" toggle flips them to `type=text` | Luhn-valid card numbers typed into a plain text box |
| `autocomplete` payment fields (`cc-number`, `cc-csc`, …) | SSN-shaped values |
| One-time codes and anything named like a secret | Anything labelled *SSN / passport / CVV / IBAN / date of birth / password* |
| Hidden inputs, CSRF and captcha tokens | Credential-looking URL parameters (`?token=…`) |

Redacted fields keep their **question** and drop the answer — losing "you were asked for an SSN
here" would be worse than losing the digits.

Real job applications also carry EEO self-identification (gender, race, veteran status), which is
GDPR Article 9 special-category data. That is why deletion is immediate and export exists.

## How it works

```
content script (every frame)                        background
┌──────────────────────────────────────┐           ┌────────────────────┐
│ field-identity.js  label + classify   │           │ background.js      │
│ redact.js          value guards       │  message  │   db.js  IndexedDB │
│ collect.js         document assembly  │ ────────► │   (extension       │
│ capture.js         events + the gate  │   800ms   │    origin)         │
└──────────────────────────────────────┘           └────────────────────┘
```

**Capture does not use the `submit` event.** Ashby's application form has no `<form>` element and
never navigates; Workday's is an eight-step wizard. So input events are journaled and the draft is
finalised on whichever signal arrives first — a real submit, a click on a submit-like control, an
SPA route change, or the page going away. Anything unfinished is kept as `abandoned`.

**IndexedDB lives in the background only.** A content script's IndexedDB belongs to the *page's*
origin, so writing there would scatter the archive across every site you visit.

**A choice group collapses into one field.** Storing each radio separately produced `"Yes": on` and
lost the question — which defeats the entire point.

## Label coverage

Getting a human-readable question for each answer is the core problem. Field `name`s are frequently
UUIDs, `label[for]` sometimes points at nothing, and Google Forms barely uses native form controls
at all. Measured against real forms:

| Platform | Coverage |
| --- | --- |
| Greenhouse | 100% (8/8) |
| Lever | 100% (24/24) |
| Ashby | 91% (10/11) |
| Google Forms | 100% (10/10) |
| Tally | 100% (5/5) |
| Plain HTML | 90–100% |

Not measured: **Workday** and **LinkedIn Easy Apply**, both behind authentication.

## Development

```bash
npm install
npm test
```

Plain JavaScript, no bundler, no build step. Every module has a UMD-ish wrapper so it loads as a
content script *and* imports into Node tests. Requires Node ≥ 20.14.

- `src/` — the extension.
- `testbed/` — twelve offline pages covering every form shape worth testing, so nothing needs a live
  job application. Each page states what *should* be captured; `testbed/testbed.test.js` asserts the
  same automatically. Serve them with `npm run serve` → <http://localhost:8777/testbed/>.
- `spike/` — the measurement harness. `node spike/measure.js <url|file>` scores any form's label
  coverage; `spike/samples/` holds captured real-form markup used purely as test fixtures.

Paste `src/field-identity.js` into a DevTools console on any form to get a coverage report for it.
For capture diagnostics, set `localStorage.FA_DEBUG = "1"` and reload — every field seen, skipped,
or held back is logged with the reason.

## Known limits

**Impossible for any extension**

- Closed shadow roots (`attachShadow({mode:'closed'})`). Open roots work at any depth.
- Browser-internal pages (`chrome://`, `about:`) — content scripts are refused there.
- PDF forms in the built-in viewer, and canvas-rendered forms: no DOM to read.

**Design choices**

- A form where you filled a **single field and never submitted** is not saved — the same floor that
  keeps out media noise.
- A form **split across cross-origin iframes** is stored as one record per frame, not merged.
- A widget holding its value only in JavaScript state, with no DOM control behind it, is invisible.
- File inputs record the **filename only**; contents are never read.

## License

[MIT](LICENSE).
