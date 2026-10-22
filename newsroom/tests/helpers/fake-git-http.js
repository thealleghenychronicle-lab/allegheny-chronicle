// Test helper (run as a CHILD process so the synchronous git calls in the test process never block it).
// A loopback-only HTTP server that answers every request with a fixed status, and logs "METHOD URL" lines to a file.
// usage: node fake-git-http.js <status> <logfile>      prints the port on stdout once listening
"use strict";
const http = require("http");
const fs = require("fs");
const [status, logFile] = [Number(process.argv[2]), process.argv[3]];
const server = http.createServer((req, res) => {
  fs.appendFileSync(logFile, `${req.method} ${req.url}\n`);
  res.writeHead(status, { "content-type": "text/plain", ...(status === 401 ? { "www-authenticate": 'Basic realm="fake"' } : {}) });
  res.end("fake");
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
