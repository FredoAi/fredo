/**
 * #2933 — Phase-0 empirical mechanism probe for GitHub Copilot CLI telemetry capture.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * The plan chose "Copilot CLI native OTel export -> Fredo's plaintext HTTP receiver on
 * http://127.0.0.1:4318". Copilot CLI v1.0.88's own `copilot help monitoring` text is
 * self-contradictory:
 *   (a) it states that when the otlp-http exporter is in use and the endpoint resolves to
 *       http:// (explicitly including the default http://localhost:4318), "export is
 *       disabled rather than sent in cleartext; startup is not aborted" and the only signal
 *       is a warning in the process log (--log-dir / $COPILOT_HOME/logs); AND
 *   (b) its own Examples block shows `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 copilot`.
 * The probe settles (a) vs (b) with minimal real runs, and records the REAL span shape.
 *
 * HOW THE ENV IS APPLIED (sandbox-safe lever)
 * -------------------------------------------
 * Pipeline agents cannot assign env vars or chain shell commands. This script launches
 * `copilot` as a CHILD PROCESS with an explicit `env` object (node:child_process), so the
 * enablement vars are applied by the child, never by the shell. The child is `copilot`
 * only (plus `taskkill` on Windows for bounded cleanup of a timed-out tree).
 *
 * RUN WITH
 * --------
 *   bun    .opencode/scripts/copilot-otel-probe.ts --leg file
 *   node --experimental-strip-types .opencode/scripts/copilot-otel-probe.ts --leg file
 * (runtime-agnostic: no imports/exports, node builtins only; both runtimes execute it.)
 *
 * LEGS
 * ----
 *   --leg file   COPILOT_OTEL_FILE_EXPORTER_PATH=<in-repo scratch>. Auto-enables OTel and
 *                bypasses the endpoint/TLS path entirely. Summarises the JSONL: line count,
 *                resource service.name, span names + gen_ai.operation.name, conversation id,
 *                input/output tokens per span, content-key presence. THE G-028 span-shape oracle.
 *   --leg http   A plain script listener bound to 127.0.0.1:<port> (default 4318) + `copilot`
 *                launched with OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>,
 *                OTEL_EXPORTER_OTLP_PROTOCOL=http/json, OTEL_SERVICE_NAME=copilot-cli. Records
 *                whether ANY request reached the listener. If none, prints the copilot process
 *                log lines mentioning cleartext/otlp/export (read by THIS SCRIPT, in-repo
 *                --log-dir first, then COPILOT_HOME/logs) so the refusal is confirmed, not assumed.
 *   --leg all    file then http.
 *
 * FLAGS: --prompt <text>  --timeout <sec> (default 120)  --port <n> (default 4318)
 *        --out <jsonl path>  --log-dir <dir>  --keep-raw
 * Prints machine-readable `PROBE_*` lines and a final `PROBE_JSON {...}` verdict per leg.
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TMP_DIR = path.join(REPO_ROOT, ".opencode", "tmp", "2933");

const CONTENT_KEYS = [
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
];
const LOG_FILTER = /cleartext|otlp|export|tls|https?:|disabled|4318|endpoint|otel/i;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--leg") out.leg = argv[++i];
    else if (a === "--prompt") out.prompt = argv[++i];
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--log-dir") out.logDir = argv[++i];
    else if (a === "--content") out.content = argv[++i];
    else if (a === "--keep-raw") out.keepRaw = true;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const leg = opts.leg || "file";
const prompt = opts.prompt || "reply with the single word ok";
const timeoutSec = Number.isFinite(opts.timeout) ? opts.timeout : 120;
const port = Number.isFinite(opts.port) ? opts.port : 4318;
const outPath = path.resolve(REPO_ROOT, opts.out || path.join(".opencode", "tmp", "2933", "copilot-otel.jsonl"));
const logDir = path.resolve(REPO_ROOT, opts.logDir || path.join(".opencode", "tmp", "2933", "copilot-logs"));
const workDir = path.join(TMP_DIR, "probe-workdir");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Normalise either an OTLP key/value array OR a plain attribute map to a flat object. */
function attrsToMap(arr) {
  const map = {};
  const norm = (v) => {
    if (v && typeof v === "object") {
      if (typeof v.stringValue === "string") return v.stringValue;
      if (v.intValue !== undefined) return v.intValue;
      if (v.doubleValue !== undefined) return v.doubleValue;
      if (v.boolValue !== undefined) return v.boolValue;
    }
    return v;
  };
  if (Array.isArray(arr)) {
    for (const kv of arr) {
      if (!kv || typeof kv.key !== "string") continue;
      map[kv.key] = norm(kv.value);
    }
  } else if (arr && typeof arr === "object") {
    for (const [k, v] of Object.entries(arr)) map[k] = norm(v);
  }
  return map;
}

/** Recursively collect { res, span } pairs from an OTLP/JSON object (resourceSpans or flat). */
function collectSpans(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectSpans(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.resourceSpans)) {
    for (const rs of node.resourceSpans) {
      const res = attrsToMap(rs && rs.resource && rs.resource.attributes);
      for (const ss of (rs && rs.scopeSpans) || []) {
        for (const sp of (ss && ss.spans) || []) out.push({ res, span: sp, scope: ss && ss.scope });
      }
    }
    return;
  }
  if (typeof node.name === "string" && (node.attributes || node.startTimeUnixNano || node.startTime || node.type === "span")) {
    out.push({ res: attrsToMap(node.resource && node.resource.attributes), span: node });
  }
}

function spanHasEnd(span) {
  if (!span) return false;
  if (span.endTimeUnixNano !== undefined && span.endTimeUnixNano !== null && span.endTimeUnixNano !== "") return true;
  if (Array.isArray(span.endTime) && span.endTime.length > 0) return true;
  return false;
}

function spanSummary(entry) {
  const m = attrsToMap(entry.span && entry.span.attributes);
  const res = entry.res || {};
  return {
    name: (entry.span && entry.span.name) || null,
    op: m["gen_ai.operation.name"] === undefined ? null : m["gen_ai.operation.name"],
    conv: m["gen_ai.conversation.id"] === undefined ? null : m["gen_ai.conversation.id"],
    agentName: m["gen_ai.agent.name"] === undefined ? null : m["gen_ai.agent.name"],
    model: (m["gen_ai.response.model"] || m["gen_ai.request.model"]) === undefined
      ? null
      : (m["gen_ai.response.model"] || m["gen_ai.request.model"]),
    inputTokens: m["gen_ai.usage.input_tokens"] === undefined ? null : m["gen_ai.usage.input_tokens"],
    outputTokens: m["gen_ai.usage.output_tokens"] === undefined ? null : m["gen_ai.usage.output_tokens"],
    contentKeys: CONTENT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(m, k)),
    attrKeys: Object.keys(m).length,
    resServiceName: res["service.name"] === undefined ? null : res["service.name"],
    hasEnd: spanHasEnd(entry.span),
  };
}

/**
 * Resolve the `copilot` launcher. A bare `spawn("copilot")` fails with ENOENT on Windows
 * because the launcher is an .exe/.cmd on PATH, not a bare name libuv can resolve. We search
 * PATH for the real launcher (preferring a native .exe, then the .cmd/.bat shim) and run the
 * shim through the command interpreter when required.
 */
function resolveCopilotCandidates() {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const found = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, "copilot" + ext);
      try {
        if (fs.existsSync(p)) found.push(p);
      } catch (_) {
        /* ignore */
      }
    }
  }
  return found;
}

function pickCopilot(candidates) {
  const byExt = (re) => candidates.find((c) => re.test(c));
  return byExt(/\.exe$/i) || byExt(/\.cmd$/i) || byExt(/\.bat$/i) || byExt(/\.ps1$/i) || candidates[0] || null;
}

function buildSpawnSpec(target, args) {
  if (!target) return { file: "copilot", args, shell: false, mode: "bare" };
  if (/\.exe$/i.test(target)) return { file: target, args, shell: false, mode: "exe" };
  if (/\.ps1$/i.test(target)) {
    return {
      file: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...args],
      shell: false,
      mode: "ps1",
    };
  }
  // .cmd / .bat: the command interpreter must run it; pre-quote each arg for cmd.exe.
  const q = (s) => (/[\s"]/.test(String(s)) ? '"' + String(s).replace(/"/g, '\\"') + '"' : String(s));
  const line = [q(target), ...args.map(q)].join(" ");
  return { file: line, args: [], shell: true, mode: "cmd" };
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      return;
    } catch (_) {
      /* fall through */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch (_) {
    /* ignore */
  }
}

function runCopilot(env) {
  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--allow-all-tools",
      "--no-auto-update",
      "--no-color",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--log-dir", logDir,
    ];
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const started = Date.now();
    const spec = buildSpawnSpec(pickCopilot(resolveCopilotCandidates()), args);
    try {
      child = spawn(spec.file, spec.args, {
        cwd: workDir,
        env,
        shell: spec.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: null, spawnError: String((e && e.message) || e), stdout, stderr, timedOut, ms: 0 });
      return;
    }
    const cap = (s) => (s.length > 40000 ? s.slice(s.length - 40000) : s);
    child.stdout.on("data", (d) => { stdout = cap(stdout + d.toString("utf8")); });
    child.stderr.on("data", (d) => { stderr = cap(stderr + d.toString("utf8")); });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, spawnError: String((e && e.message) || e), stdout, stderr, timedOut, ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, ms: Date.now() - started });
    });
  });
}

function printRunResult(run) {
  console.log(`PROBE_RUN exit=${run.code === null ? "null" : run.code}${run.signal ? " signal=" + run.signal : ""} timedOut=${run.timedOut} ms=${run.ms}`);
  if (run.spawnError) console.log(`PROBE_SPAWN_ERROR ${run.spawnError}`);
  const tail = (s) => (s || "").trim().split(/\r?\n/).slice(-12).join(" | ");
  if (run.stdout && run.stdout.trim()) console.log(`PROBE_STDOUT_TAIL ${tail(run.stdout)}`);
  if (run.stderr && run.stderr.trim()) console.log(`PROBE_STDERR_TAIL ${tail(run.stderr)}`);
}

/* ----------------------------- leg 1: file exporter ----------------------------- */

async function legFile() {
  ensureDir(TMP_DIR);
  ensureDir(workDir);
  ensureDir(logDir);
  ensureDir(path.dirname(outPath));
  if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true });

  const contentOn = String(opts.content || "on").toLowerCase() !== "off";
  const env = {
    ...process.env,
    COPILOT_OTEL_FILE_EXPORTER_PATH: outPath,
    COPILOT_OTEL_EXPORTER_TYPE: "file",
    OTEL_SERVICE_NAME: "copilot-cli",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: contentOn ? "true" : "false",
    COPILOT_AUTO_UPDATE: "false",
    NO_COLOR: "1",
  };
  console.log(`PROBE_LEG file out=${path.relative(REPO_ROOT, outPath)} logDir=${path.relative(REPO_ROOT, logDir)} content=${contentOn ? "on" : "off"} prompt=${JSON.stringify(prompt)}`);
  const run = await runCopilot(env);
  printRunResult(run);

  let verdict = { leg: "file", exists: false, bytes: 0, lines: 0, parseErrors: 0, spans: [], resources: [], metrics: 0, logs: 0 };
  if (!fs.existsSync(outPath)) {
    console.log("PROBE_FILE exists=false");
  } else {
    verdict = { leg: "file", ...summarizeJsonl(fs.readFileSync(outPath, "utf8"), false) };
  }
  console.log(`PROBE_JSON ${JSON.stringify(verdict)}`);
  return verdict;
}

/** Parse an existing JSONL (as written by the file exporter) into a compact verdict. */
function summarizeJsonl(raw, dumpAttrs) {
  const verdict = {
    exists: true,
    bytes: Buffer.byteLength(raw),
    lines: 0,
    parseErrors: 0,
    lineTypes: {},
    spans: [],
    resources: [],
    resourceAttrs: {},
    metrics: 0,
    logs: 0,
    scopes: [],
  };
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  verdict.lines = lines.length;
  const spanEntries = [];
  let firstLine = "";
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      verdict.parseErrors++;
      continue;
    }
    if (!firstLine) firstLine = line;
    const t = obj && obj.type ? String(obj.type) : obj && Array.isArray(obj.resourceSpans) ? "otlp-envelope" : "unknown";
    verdict.lineTypes[t] = (verdict.lineTypes[t] || 0) + 1;
    if (t === "resource") {
      // Merge resource-level attributes (service.name lives here) into one map.
      Object.assign(verdict.resourceAttrs, attrsToMap(obj.attributes));
    }
    if (t === "scope") verdict.scopes.push(obj.name || null);
    if (obj && Array.isArray(obj.resourceSpans)) spanEntries.push(...collectSpans(obj, []));
    else if (obj && (obj.type === "span" || obj.name || obj.attributes)) collectSpans(obj, spanEntries);
    if (obj && (Array.isArray(obj.resourceMetrics) || obj.scopeMetrics || t === "metric")) verdict.metrics++;
    if (obj && (Array.isArray(obj.resourceLogs) || obj.scopeLogs || obj.logRecords || t === "log")) verdict.logs++;
  }
  console.log(`PROBE_FILE exists=true bytes=${verdict.bytes} lines=${verdict.lines} parseErrors=${verdict.parseErrors} lineTypes=${JSON.stringify(verdict.lineTypes)}`);
  console.log(`PROBE_RAW_FIRST_LINE ${firstLine.slice(0, 900)}`);
  if (Object.keys(verdict.resourceAttrs).length) {
    console.log(`PROBE_RESOURCE_ATTRS ${JSON.stringify(verdict.resourceAttrs).slice(0, 1500)}`);
    if (verdict.resourceAttrs["service.name"] !== undefined) verdict.resources.push(verdict.resourceAttrs["service.name"]);
  }
  for (const entry of spanEntries) {
    const s = spanSummary(entry);
    verdict.spans.push(s);
    if (s.resServiceName && !verdict.resources.includes(s.resServiceName)) verdict.resources.push(s.resServiceName);
    console.log(
      `PROBE_SPAN name=${JSON.stringify(s.name)} op=${JSON.stringify(s.op)} conv=${JSON.stringify(s.conv)} ` +
      `agent=${JSON.stringify(s.agentName)} model=${JSON.stringify(s.model)} in=${s.inputTokens} out=${s.outputTokens} ` +
      `ended=${s.hasEnd} contentKeys=${JSON.stringify(s.contentKeys)}`
    );
    if (dumpAttrs) {
      const m = attrsToMap(entry.span && entry.span.attributes);
      const slim = {};
      for (const [k, v] of Object.entries(m)) slim[k] = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v;
      console.log(`PROBE_SPAN_ATTRS name=${JSON.stringify(s.name)} ${JSON.stringify(slim).slice(0, 4000)}`);
      console.log(
        `PROBE_SPAN_META name=${JSON.stringify(s.name)} topKeys=${JSON.stringify(Object.keys(entry.span || {}))} ` +
        `startTime=${JSON.stringify(entry.span && entry.span.startTime)} endTime=${JSON.stringify(entry.span && entry.span.endTime)} ` +
        `kind=${entry.span && entry.span.kind} parentSpanId=${JSON.stringify(entry.span && entry.span.parentSpanId)}`
      );
      console.log(`PROBE_SPAN_RESOURCE name=${JSON.stringify(s.name)} ${JSON.stringify(entry.span && entry.span.resource).slice(0, 1500)}`);
      console.log(`PROBE_SPAN_SCOPE name=${JSON.stringify(s.name)} ${JSON.stringify(entry.span && entry.span.instrumentationScope).slice(0, 800)}`);
      console.log(`PROBE_SPAN_STATUS name=${JSON.stringify(s.name)} ${JSON.stringify(entry.span && entry.span.status)} events=${JSON.stringify(entry.span && entry.span.events).slice(0, 900)}`);
    }
  }
  console.log(`PROBE_FILE_VERDICT fileExporter=${spanEntries.length > 0 ? "works" : verdict.lines > 0 ? "wrote-non-span-lines" : "empty"} spans=${spanEntries.length}`);
  return verdict;
}

/* ------------------------- leg 1b: re-read an existing JSONL ------------------------- */

async function legRead() {
  if (!fs.existsSync(outPath)) {
    console.log(`PROBE_READ missing=${path.relative(REPO_ROOT, outPath)}`);
    process.exitCode = 1;
    return;
  }
  const verdict = summarizeJsonl(fs.readFileSync(outPath, "utf8"), true);
  console.log(
    `PROBE_JSON ${JSON.stringify({
      leg: "read",
      lineTypes: verdict.lineTypes,
      resources: verdict.resources,
      resourceAttrs: verdict.resourceAttrs,
      spanNames: verdict.spans.map((s) => s.name),
      opNames: verdict.spans.map((s) => s.op),
      contentKeysBySpan: verdict.spans.map((s) => s.contentKeys),
    })}`
  );
}

/* ----------------------------- leg 2: HTTP endpoint ----------------------------- */

function readLogs(maxLines) {
  const dirs = [logDir];
  const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
  dirs.push(path.join(copilotHome, "logs"));
  const hits = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      console.log(`PROBE_LOG_DIR missing=${dir === logDir ? "in-repo-log-dir" : "copilot-home-logs"}`);
      continue;
    }
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".log"));
    } catch (_) {
      files = [];
    }
    files.sort((a, b) => {
      try { return fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs; } catch (_) { return 0; }
    });
    console.log(`PROBE_LOG_DIR found=${dir === logDir ? "in-repo-log-dir" : "copilot-home-logs"} files=${files.length}`);
    for (const f of files) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(dir, f), "utf8");
      } catch (_) {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (LOG_FILTER.test(line)) hits.push(line.trim().slice(0, 400));
      }
    }
  }
  const tail = hits.slice(-maxLines);
  for (const h of tail) console.log(`PROBE_LOG ${h}`);
  console.log(`PROBE_LOG_HITS total=${hits.length} shown=${tail.length}`);
  return tail;
}

async function legHttp() {
  ensureDir(TMP_DIR);
  ensureDir(workDir);
  ensureDir(logDir);

  const received = [];
  const bodyDir = path.join(TMP_DIR, "http-bodies");
  ensureDir(bodyDir);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const n = received.length;
      const bodyFile = path.join(bodyDir, `req-${n}.body`);
      try {
        fs.writeFileSync(bodyFile, body);
      } catch (_) {
        /* ignore */
      }
      received.push({
        method: req.method,
        path: req.url,
        contentType: req.headers["content-type"] || null,
        bytes: body.length,
        bodyFile: path.relative(REPO_ROOT, bodyFile),
        preview: body.slice(0, 300).toString("utf8"),
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });

  const listening = await new Promise((resolve) => {
    server.on("error", (e) => resolve(`error:${e.code || e.message}`));
    server.listen(port, "127.0.0.1", () => resolve("ok"));
  });
  console.log(`PROBE_LEG http port=${port} listen=${listening}`);

  const env = {
    ...process.env,
    COPILOT_OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_SERVICE_NAME: "copilot-cli",
    OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: "true",
    COPILOT_AUTO_UPDATE: "false",
    NO_COLOR: "1",
  };
  const run = await runCopilot(env);
  printRunResult(run);

  // Grace period for a late/batched export before we stop accepting.
  await new Promise((r) => setTimeout(r, 3000));
  await new Promise((r) => server.close(() => r()));

  console.log(`PROBE_HTTP requests=${received.length}`);
  for (const req of received) {
    console.log(`PROBE_HTTP_REQ ${req.method} ${req.path} content-type=${req.contentType} bytes=${req.bytes} body=${req.bodyFile} preview=${JSON.stringify(req.preview.slice(0, 200))}`);
  }

  let logEvidence = [];
  if (received.length === 0) {
    logEvidence = readLogs(40);
  }
  const verdict = {
    leg: "http",
    listen: listening,
    port,
    requests: received.length,
    endpoint: `http://127.0.0.1:${port}`,
    refusalLogFound: logEvidence.length > 0,
    logEvidence,
  };
  console.log(`PROBE_HTTP_VERDICT received=${received.length > 0 ? "yes" : "no"} requests=${received.length} refusalLogFound=${logEvidence.length > 0}`);
  console.log(`PROBE_JSON ${JSON.stringify(verdict)}`);
  return verdict;
}

/* ---------------- leg 2b: skeleton of a captured OTLP body (no values) ---------------- */

async function legBody() {
  if (!fs.existsSync(outPath)) {
    console.log(`PROBE_BODY missing=${path.relative(REPO_ROOT, outPath)}`);
    process.exitCode = 1;
    return;
  }
  const obj = JSON.parse(fs.readFileSync(outPath, "utf8"));
  console.log(`PROBE_BODY topKeys=${JSON.stringify(Object.keys(obj))}`);
  if (obj.resourceMetrics) {
    const names = [];
    for (const rm of obj.resourceMetrics) for (const sm of rm.scopeMetrics || []) for (const mt of sm.metrics || []) names.push(mt.name);
    console.log(`PROBE_BODY_METRICS ${JSON.stringify(names)}`);
  }
  for (const rs of obj.resourceSpans || []) {
    console.log(`PROBE_BODY_RESOURCE ${JSON.stringify(attrsToMap(rs.resource && rs.resource.attributes))}`);
    console.log(`PROBE_BODY_RESOURCE_SCHEMA ${JSON.stringify(rs.resource && rs.resource.schemaUrl)}`);
    for (const ss of rs.scopeSpans || []) {
      console.log(`PROBE_BODY_SCOPE ${JSON.stringify(ss.scope)} schemaUrl=${JSON.stringify(ss.schemaUrl)}`);
      for (const sp of ss.spans || []) {
        const m = attrsToMap(sp.attributes);
        console.log(
          `PROBE_BODY_SPAN name=${JSON.stringify(sp.name)} kind=${sp.kind} start=${JSON.stringify(sp.startTimeUnixNano)} ` +
          `end=${JSON.stringify(sp.endTimeUnixNano)} parent=${JSON.stringify(sp.parentSpanId)} status=${JSON.stringify(sp.status)} ` +
          `dropped=${sp.droppedAttributesCount} attrKeys=${JSON.stringify(Object.keys(m))} events=${JSON.stringify((sp.events || []).map((e) => e.name))}`
        );
      }
    }
  }
}

/* --------------------------- leg 0: resolve launcher --------------------------- */

async function legResolve() {
  const candidates = resolveCopilotCandidates();
  console.log(`PROBE_RESOLVE candidates=${candidates.length}`);
  for (const c of candidates) console.log(`PROBE_RESOLVE_CANDIDATE ${c}`);
  const picked = pickCopilot(candidates);
  const spec = buildSpawnSpec(picked, ["--version"]);
  console.log(`PROBE_RESOLVE_PICK mode=${spec.mode}`);
  const run = await new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    try {
      child = spawn(spec.file, spec.args, { shell: spec.shell, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, spawnError: String((e && e.message) || e), stdout, stderr });
      return;
    }
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => resolve({ code: null, spawnError: String((e && e.message) || e), stdout, stderr }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  console.log(`PROBE_RESOLVE_VERSION exit=${run.code === null ? "null" : run.code}${run.spawnError ? " error=" + run.spawnError : ""} out=${JSON.stringify((run.stdout || "").trim().slice(0, 200))}`);
}

async function main() {
  ensureDir(TMP_DIR);
  const results = [];
  if (leg === "resolve") {
    await legResolve();
    return;
  }
  if (leg === "read") {
    await legRead();
    return;
  }
  if (leg === "body") {
    await legBody();
    return;
  }
  if (leg === "file" || leg === "all") results.push(await legFile());
  if (leg === "http" || leg === "all") results.push(await legHttp());
  if (results.length === 0) {
    console.log("PROBE_USAGE --leg resolve|read|file|http|all");
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.log(`PROBE_FATAL ${String((e && e.stack) || e)}`);
  process.exitCode = 1;
});
