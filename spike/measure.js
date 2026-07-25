"use strict";

/**
 * Run the field-identity resolver against real, live application forms.
 *
 *   node spike/measure.js <url> [<url> ...]
 *
 * Fetches each page and analyses it under jsdom. This measures server-rendered
 * markup only — Greenhouse and Workday largely qualify, Ashby and Lever render
 * client-side and will report ~0 fields here. For those, paste field-identity.js
 * into a real DevTools console instead; see spike/README.md.
 */

const { JSDOM } = require("jsdom");

globalThis.__FORM_SPIKE_NO_AUTORUN = true;
const spike = require("../src/field-identity.js");

const GATE = 80;

async function measure(target) {
  // Local sample of an already-rendered DOM, captured from a client-rendered form.
  if (!/^https?:/.test(target)) {
    const fs = require("node:fs");
    const html = fs.readFileSync(target, "utf8");
    const url = (html.match(/https:\/\/\S+/) || ["https://sample.local/form"])[0];
    const dom = new JSDOM(html, { url });
    return {
      url: `${target}  (captured from ${url})`,
      status: "file",
      result: spike.analyze(dom.window.document, dom.window.location, { checkVisibility: false }),
    };
  }

  const res = await fetch(target, {
    headers: {
      // Some boards serve a stub to unrecognised agents.
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const html = await res.text();
  const dom = new JSDOM(html, { url: res.url });
  // jsdom has no layout engine, so visibility filtering is disabled here.
  const result = spike.analyze(dom.window.document, dom.window.location, { checkVisibility: false });

  return { url: res.url, status: res.status, result };
}

(async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("usage: node spike/measure.js <url> [<url> ...]");
    process.exit(1);
  }

  for (const url of urls) {
    let out;
    try {
      out = await measure(url);
    } catch (err) {
      console.log(`\n${url}\n  FAILED: ${err.message}`);
      continue;
    }

    const { result, status } = out;
    const pass = result.coveragePct >= GATE;
    console.log(`\n${out.url}  [${status}]`);

    if (status !== 200 && status !== "file") {
      console.log(`  HTTP ${status} — page not served, nothing measured (expired posting?)`);
      continue;
    }
    if (result.totalFields === 0) {
      console.log("  0 fields in server-rendered HTML — client-rendered form, needs a live console run");
      continue;
    }

    console.log(
      `  coverage ${result.coveragePct}%  (${result.readableFields}/${result.totalFields})  ${pass ? "PASS" : "BELOW GATE"}`
    );
    console.log(`  rules: ${JSON.stringify(result.bySource)}`);
    console.log(`  excluded: ${result.skipped.excluded}`);
    console.log(`  signature: ${result.signature}`);

    const weak = result.fields.filter((f) => f.confidence < spike.READABLE_THRESHOLD);
    if (weak.length) {
      console.log(`  unresolved (${weak.length}):`);
      for (const f of weak.slice(0, 15)) {
        console.log(`    - [${f.labelSource}] name="${f.name}" id="${f.domId}" -> "${f.label}"`);
      }
    }
    const sample = result.fields.filter((f) => f.confidence >= spike.READABLE_THRESHOLD).slice(0, 12);
    console.log("  resolved sample:");
    for (const f of sample) console.log(`    - [${f.labelSource}] "${f.label}"`);
  }
})();
