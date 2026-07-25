// Tiny static server for the offline test pages. Dev-only; not part of the extension.
//   node spike/serve.js  ->  http://localhost:8777/testbed/    (all form shapes)
//                            http://localhost:8777/spike/fixture.html
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Project root, so both testbed/ and spike/ are reachable.
const ROOT = path.resolve(__dirname, "..");
const PORT = 8777;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "testbed/index.html";
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);
    // path.relative, not startsWith: a prefix test lets a sibling directory
    // ("form-archive-notes") through.
    const inside = path.relative(ROOT, file);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
      res.end(buf);
    });
  })
  // Loopback only — a dev fixture server has no business on the LAN.
  .listen(PORT, "127.0.0.1", () => console.log(`testbed: http://localhost:${PORT}/testbed/`));
