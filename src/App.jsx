import React, { useEffect, useMemo, useState } from "react";

// --- Tiny utilities ---------------------------------------------------------
const nowISO = () => new Date().toISOString();
const fmtDate = (d) => new Date(d).toLocaleString();
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

// Heuristic: decide if a string is mostly Hebrew (RTL) without using Unicode escapes in regex
function isHebrewCodePoint(cp) { return cp >= 0x0590 && cp <= 0x05FF; }
function isLatinCodePoint(cp) { return (cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A); }
function isMostlyHebrew(s) {
  if (!s) return false;
  let heb = 0, letters = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (isHebrewCodePoint(cp)) { heb++; letters++; }
    else if (isLatinCodePoint(cp)) { letters++; }
  }
  return letters ? (heb / letters) >= 0.5 : false;
}
function detectDir(s) { return isMostlyHebrew(s) ? 'rtl' : 'ltr'; }

// He+En friendly tokenization (keeps words, punctuation, and spaces as tokens)
function tokenize(str) {
  if (!str) return [];
  // Split into: words (including Hebrew), punctuation, whitespace
  // NOTE: uses explicit Unicode block for Hebrew to avoid locale issues
  const re = /([\u0590-\u05FF\w]+|\s+|[^\u0590-\u05FF\w\s])/gu;
  return str.match(re) || [str];
}

// Longest Common Subsequence (word-level)
function lcsMatrix(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diffWords(oldStr, newStr) {
  const A = tokenize(oldStr);
  const B = tokenize(newStr);
  const dp = lcsMatrix(A, B);
  let i = A.length, j = B.length;
  const ops = [];
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      ops.push({ type: "equal", value: A[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: "delete", value: A[i - 1] });
      i--;
    } else {
      ops.push({ type: "insert", value: B[j - 1] });
      j--;
    }
  }
  while (i > 0) { ops.push({ type: "delete", value: A[--i] }); }
  while (j > 0) { ops.push({ type: "insert", value: B[--j] }); }
  ops.reverse();
  return ops;
}

function classNames(...arr) { return arr.filter(Boolean).join(" "); }

// --- OpenAI call ------------------------------------------------------------
async function openAITranslate({ apiKey, model, systemPrompt, sourceText, targetLang, temperatureValue, maxCompletionTokens }) {
  // IMPORTANT: Escape the backslash before apostrophe to avoid invalid Unicode escape in some bundlers.
  const finalSystem =
    (systemPrompt?.trim()) ||
    "You are a professional translator. Keep the author\\'s logic and structure. Write in clear, natural {TARGET} with no extra commentary.";
  const sys = finalSystem.replace("{TARGET}", targetLang || "English");

  const messages = [
    { role: "system", content: sys },
    {
      role: "user",
      content: `Translate the SOURCE text into ${targetLang || "English"}. Return translation only.\n\nSOURCE:\`\`\`\n${sourceText}\n\`\`\`\n`,
    },
  ];

  const buildBody = () => {
    const body = { model: model || "gpt-4o-mini", messages };
    // Only include temperature if user provided one; some models fix it to 1 and reject overrides.
    const tRaw = (temperatureValue ?? "").toString().trim();
    if (tRaw !== "") {
      const t = Number(tRaw);
      if (!Number.isNaN(t)) body.temperature = t; // omit entirely if blank/invalid
    }
    const mctRaw = (maxCompletionTokens ?? "").toString().trim();
    if (mctRaw !== "") {
      const mct = parseInt(mctRaw, 10);
      if (Number.isFinite(mct)) body.max_completion_tokens = mct; // modern param
    }
    return body;
  };

  const doFetch = async (body) => {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`OpenAI error ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() ?? "";
  };

  // First try with user prefs; on specific 400s, retry without offending params
  let body = buildBody();
  try {
    return await doFetch(body);
  } catch (e) {
    const msg = String(e.message || e);
    // Retry without temperature if model rejects it
    if (msg.includes("'temperature'")) {
      const { temperature, ...rest } = body; // temperature may or may not exist
      delete rest.temperature;
      return await doFetch(rest);
    }
    // Retry switching token param if some downstream lib injected max_tokens (defensive)
    if (msg.includes("'max_tokens'")) {
      const retry = { ...body };
      delete retry.max_tokens;
      if (typeof retry.max_completion_tokens === "undefined" && (maxCompletionTokens ?? "").toString().trim() !== "") {
        retry.max_completion_tokens = parseInt(maxCompletionTokens, 10);
      }
      return await doFetch(retry);
    }
    throw e;
  }
}

// --- Storage ---------------------------------------------------------------
const LS_KEYS = {
  apiKey: "tds_api_key",
  prefs: "tds_prefs",
  history: "tds_history_v1",
};

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// --- Components -------------------------------------------------------------
function TextArea({ label, value, onChange, placeholder, rows = 10, dir = "auto", id, mono=false }) {
  return (
    <label className="block">
      <div className="mb-1 text-sm text-zinc-600">{label}</div>
      <textarea
        id={id}
        dir={dir}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={classNames(
          "w-full resize-y rounded-2xl border border-zinc-200 bg-white/60 p-3 shadow-sm outline-none",
          "focus:ring-2 focus:ring-indigo-300",
          mono ? "font-mono" : ""
        )}
      />
    </label>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm text-zinc-600">{label}</div>
      {children}
    </div>
  );
}

function Pill({ children }) {
  return <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{children}</span>;
}

function Button({ children, onClick, variant = "primary", disabled }) {
  const base = "inline-flex items-center justify-center rounded-xl px-4 py-2 text-sm font-medium shadow-sm transition";
  const variants = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300",
    ghost: "bg-white/70 hover:bg-white text-zinc-800 border border-zinc-200",
    warn: "bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={classNames(base, variants[variant])}>
      {children}
    </button>
  );
}

function Card({ title, subtitle, right, children }) {
  return (
    <div className="rounded-3xl border border-zinc-200 bg-white/70 p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-lg font-semibold text-zinc-900">{title}</div>
          {subtitle && <div className="text-xs text-zinc-500">{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="rounded-md bg-green-100 px-2 py-0.5 text-green-800">Added</span>
      <span className="rounded-md bg-rose-100 px-2 py-0.5 text-rose-800 line-through">Removed</span>
      <Pill>Word-level (LCS)</Pill>
    </div>
  );
}

// Renders inline diff with styling akin to track changes
function InlineDiff({ oldText, newText }) {
  const ops = useMemo(() => diffWords(oldText, newText), [oldText, newText]);
  return (
    <div className="prose max-w-none whitespace-pre-wrap leading-8" dir="auto">
      {ops.map((op, idx) => {
        if (op.type === "equal") return <span key={idx}>{op.value}</span>;
        if (op.type === "insert")
          return (
            <span
              key={idx}
              className="rounded-md bg-green-100/80 px-0.5 text-green-900 underline decoration-green-700/50"
              title="Added by GPT"
            >
              {op.value}
            </span>
          );
        if (op.type === "delete")
          return (
            <span
              key={idx}
              className="rounded-md bg-rose-50/80 px-0.5 text-rose-800 line-through decoration-rose-700/60"
              title="Removed from automated translation"
            >
              {op.value}
            </span>
          );
        return null;
      })}
    </div>
  );
}

// Editable Track-Changes view, DOM-managed to avoid React re-renders while typing.
// This fixes: IME/Hebrew reversal, duplicate characters, and broken undo.
function InlineDiffEditor({ oldText, newText, onChange, dir = 'auto', refreshTick = 0 }) {
  const rootRef = React.useRef(null);
  const composingRef = React.useRef(false);
  const editingRef = React.useRef(false); // true while user is typing in this box
  const lastAppliedRef = React.useRef("");

  function esc(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function renderOpsToHTML(list, dirMode) {
    const dirAttr = dirMode && dirMode !== 'auto' ? ` dir="${dirMode}"` : '';
    return list.map(op => {
      const v = esc(op.value);
      if (op.type === 'equal') return `<bdi${dirAttr} data-type="equal">${v}</bdi>`;
      if (op.type === 'insert') return `<bdi${dirAttr} data-type="insert" class="rounded-md bg-green-100/80 px-0.5 text-green-900 underline decoration-green-700/50">${v}</bdi>`;
      if (op.type === 'delete') return `<bdi${dirAttr} data-type="delete" contenteditable="false" class="rounded-md bg-rose-50/80 px-0.5 text-rose-800 line-through decoration-rose-700/60 select-text">${v}</bdi>`;
      return '';
    }).join('');
  }
  function plainFromRoot(root) {
    let out = '';
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const t = el.getAttribute ? el.getAttribute('data-type') : null;
      if (t === 'delete') return; // skip deletions entirely
      for (const child of el.childNodes) walk(child);
    }
    for (const child of root.childNodes) walk(child);
    return out;
  }

  // Sync from props or manual refresh. IMPORTANT: do not repaint while editing/composing.
  useEffect(() => {
    const root = rootRef.current; if (!root) return;
    if (composingRef.current || editingRef.current) return;
    const html = renderOpsToHTML(diffWords(oldText, newText), dir);
    if (root.innerHTML !== html) {
      root.innerHTML = html;
      lastAppliedRef.current = newText;
    }
  }, [oldText, newText, refreshTick, dir]);

  function handleFocus() { editingRef.current = true; }
  function handleCompositionStart() { composingRef.current = true; editingRef.current = true; }
  function handleCompositionEnd() { composingRef.current = false; }

  function handleInput() {
    const root = rootRef.current; if (!root) return;
    editingRef.current = true;
    const plain = plainFromRoot(root);
    if (plain !== lastAppliedRef.current) { lastAppliedRef.current = plain; onChange(plain); }
  }

  function handleBlur() {
    const root = rootRef.current; if (!root) return;
    const plain = plainFromRoot(root);
    if (plain !== lastAppliedRef.current) { lastAppliedRef.current = plain; onChange(plain); }
    editingRef.current = false;
    // Repaint highlights to reflect the latest text
    const html = renderOpsToHTML(diffWords(oldText, plain), dir);
    if (root.innerHTML !== html) root.innerHTML = html;
  }

  function handlePaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, text);
  }

  const unicodeBidiMode = dir === 'auto' ? 'plaintext' : 'isolate-override';

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      onFocus={handleFocus}
      onInput={handleInput}
      onBlur={handleBlur}
      onPaste={handlePaste}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      className="prose max-w-none whitespace-pre-wrap leading-8 outline-none"
      dir={dir}
      style={{ cursor: 'text', unicodeBidi: unicodeBidiMode, direction: dir }}
      title="Edit here. Red deletions are non-editable; typing adds green text."
    />
  );
}

// --- Simple self-tests ------------------------------------------------------
function assert(name, condition) {
  if (!condition) throw new Error(`Test failed: ${name}`);
}
function runSelfTests() {
  const results = [];
  const record = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { console.error(e); results.push({ name, ok: false, msg: e.message }); }
  };

  // Test 1: tokenize Hebrew + punctuation
  record("tokenize Hebrew & punctuation", () => {
    const t = tokenize("שלום, עולם!");
    assert("has comma token", t.includes(","));
    assert("has exclamation token", t.includes("!"));
  });

  // Test 2: diff basic replacement
  record("diff basic replacement", () => {
    const ops = diffWords("a b c", "a x c");
    const types = ops.map(o => o.type);
    assert("includes delete for b", types.includes("delete"));
    assert("includes insert for x", types.includes("insert"));
  });

  // Test 3: punctuation removal
  record("diff punctuation removal", () => {
    const ops = diffWords("Hello, world.", "Hello world.");
    const delComma = ops.find(o => o.type === "delete" && o.value === ",");
    assert("comma removed", !!delComma);
  });

  // Test 4: Hebrew prefix insert
  record("hebrew insert", () => {
    const ops = diffWords("בית", "הבית");
    const insHe = ops.find(o => o.type === "insert" && o.value === "ה");
    assert("inserted ה", !!insHe);
  });

  // Test 5: whitespace normalization (single space removed)
  record("whitespace deletion", () => {
    const ops = diffWords("a  b", "a b");
    const delSpace = ops.find(o => o.type === "delete" && o.value === " ");
    assert("one space deleted", !!delSpace);
  });

  // Test 6: RTL punctuation swap
  record("rtl punctuation swap", () => {
    const ops = diffWords("שלום.", "שלום!");
    const delDot = ops.find(o => o.type === "delete" && o.value === ".");
    const insBang = ops.find(o => o.type === "insert" && o.value === "!");
    assert("dot deleted", !!delDot);
    assert("bang inserted", !!insBang);
  });

    // Test 7: reconstruct newText by dropping deletions
  record("reconstruct new text from ops", () => {
    const oldS = "foo bar";
    const newS = "foo baz";
    const ops = diffWords(oldS, newS);
    const recon = ops.filter(o => o.type !== "delete").map(o => o.value).join("");
    assert("reconstruct equals new", recon === newS);
  });

    // Test 8: direction heuristic prefers RTL for Hebrew strings
  record("direction heuristic RTL", () => {
    const s = "אני אוהב עברית";
    if (!isMostlyHebrew(s)) throw new Error("Hebrew ratio mis-detected");
    if (detectDir(s) !== 'rtl') throw new Error("detectDir should return rtl");
  });

  return results;
}

function SelfTestsPanel() {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState(null);
  return (
    <div className="rounded-3xl border border-emerald-200 bg-emerald-50/70 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-emerald-900">Self-tests</div>
        <button
          className="text-xs rounded-lg border border-emerald-300 bg-white/70 px-2 py-1 hover:bg-white"
          onClick={() => setOpen(!open)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <div className="text-sm text-emerald-900/90">
          <button
            className="mb-2 rounded-lg border border-emerald-300 bg-white/70 px-2 py-1 text-xs hover:bg-white"
            onClick={() => setResults(runSelfTests())}
          >Run tests</button>
          {results && (
            <ul className="space-y-1">
              {results.map((r, i) => (
                <li key={i} className={r.ok ? "text-emerald-700" : "text-rose-700"}>
                  {r.ok ? "✔" : "✗"} {r.name}{r.msg ? ` — ${r.msg}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main App ---------------------------------------------------------------
export default function TranslationDiffStudio() {
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [targetLang, setTargetLang] = useState("English");
  const [systemPrompt, setSystemPrompt] = useState(
    "Type 3 translation: Keep original Hebrew/English structure and logic; natural American {TARGET}; no added ideas; preserve tone; 6th-grade clarity; short, clean sentences; return translation only."
  );
  const [sourceText, setSourceText] = useState("");
  const [autoText, setAutoText] = useState("");
  const [gptText, setGptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  // Advanced (optional): leave blank to omit
  const [temperature, setTemperature] = useState("");
  const [maxCompletionTokens, setMaxCompletionTokens] = useState("");
  // Inline editor controls
  const [editorDirMode, setEditorDirMode] = useState('auto');
  const [refreshTick, setRefreshTick] = useState(0);
  const resolvedEditorDir = editorDirMode === 'auto' ? detectDir(gptText) : editorDirMode;

  useEffect(() => {
    const k = localStorage.getItem(LS_KEYS.apiKey);
    if (k) setApiKey(k);
    const prefs = loadJSON(LS_KEYS.prefs, {});
    if (prefs.model) setModel(prefs.model);
    if (prefs.targetLang) setTargetLang(prefs.targetLang);
    if (prefs.systemPrompt) setSystemPrompt(prefs.systemPrompt);
    if (Object.prototype.hasOwnProperty.call(prefs, 'temperature')) setTemperature(String(prefs.temperature ?? ''));
    if (Object.prototype.hasOwnProperty.call(prefs, 'maxCompletionTokens')) setMaxCompletionTokens(String(prefs.maxCompletionTokens ?? ''));
    setHistory(loadJSON(LS_KEYS.history, []));
  }, []);

  useEffect(() => { localStorage.setItem(LS_KEYS.apiKey, apiKey || ""); }, [apiKey]);
  useEffect(() => { saveJSON(LS_KEYS.prefs, { model, targetLang, systemPrompt, temperature, maxCompletionTokens }); }, [model, targetLang, systemPrompt, temperature, maxCompletionTokens]);

  function pushHistory(entry) {
    const next = [{ id: uid(), date: nowISO(), ...entry }, ...history].slice(0, 50);
    setHistory(next);
    saveJSON(LS_KEYS.history, next);
  }

  async function handleGenerate() {
    setBusy(true); setError("");
    try {
      if (!apiKey) throw new Error("Missing API key. Add it in Settings.");
      if (!sourceText.trim()) throw new Error("Source text is empty.");
      const out = await openAITranslate({ apiKey, model, systemPrompt, sourceText, targetLang, temperatureValue: temperature, maxCompletionTokens });
      setGptText(out);
      pushHistory({ sourceText, autoText, gptText: out, model, targetLang, systemPrompt, kind: "generated" });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleCompareOnly() {
    pushHistory({ sourceText, autoText, gptText, model, targetLang, systemPrompt, kind: "compared" });
  }

  function loadHistory(item) {
    setSourceText(item.sourceText || "");
    setAutoText(item.autoText || "");
    setGptText(item.gptText || "");
    setModel(item.model || "gpt-4o-mini");
    setTargetLang(item.targetLang || "English");
    setSystemPrompt(item.systemPrompt || systemPrompt);
  }

  function exportHTML() {
    const style = `
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; line-height: 1.7; }
      .add { background: #dcfce7; text-decoration: underline; }
      .del { background: #ffe4e6; text-decoration: line-through; }
      pre, textarea { white-space: pre-wrap; }
    `;
    const ops = diffWords(autoText, gptText);
    const htmlDiff = ops.map(op => {
      const esc = (s) => s.replace(/[&<>]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
      if (op.type === "equal") return esc(op.value);
      if (op.type === "insert") return `<span class="add">${esc(op.value)}</span>`;
      if (op.type === "delete") return `<span class="del">${esc(op.value)}</span>`;
      return "";
    }).join("");
    const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Translation Diff</title><style>${style}</style></head>
      <body>
        <h1>Translation Diff</h1>
        <p><strong>Date:</strong> ${fmtDate(nowISO())}</p>
        <h2>Source Text</h2>
        <pre>${sourceText.replace(/[&<>]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</pre>
        <h2>Automated Translation (Baseline)</h2>
        <pre>${autoText.replace(/[&<>]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</pre>
        <h2>GPT Translation</h2>
        <pre>${gptText.replace(/[&<>]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}</pre>
        <h2>Track Changes (Inline)</h2>
        <div>${htmlDiff}</div>
      </body></html>`;

    const blob = new Blob([doc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `translation-diff-${Date.now()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const header = (
    <div className="sticky top-0 z-10 mb-4 rounded-3xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-sky-50 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-indigo-600/90" />
          <div>
            <div className="text-lg font-bold text-zinc-900">Translation Diff Studio</div>
            <div className="text-xs text-zinc-600">Paste source + auto-translation, get GPT translation and tracked changes.</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <Pill>BYO OpenAI Key</Pill>
          <Pill>Local history</Pill>
          <Pill>Export HTML</Pill>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-7xl p-4 text-zinc-900">
      {header}

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="Settings"
          subtitle="Model, target language, and your key are stored locally on this device."
          right={<Legend />}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="OpenAI API Key">
              <input
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white/60 p-2 font-mono text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </Field>
            <Field label="Model">
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white/60 p-2 font-mono text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300"
                placeholder="gpt-4o-mini"
              />
            </Field>
            <Field label="Target language">
              <select
                value={targetLang}
                onChange={(e) => setTargetLang(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white/60 p-2 text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300"
              >
                <option>English</option>
                <option>Hebrew</option>
              </select>
            </Field>
            <Field label="Temperature (optional)">
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                placeholder="auto"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white/60 p-2 font-mono text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <div className="mt-1 text-xs text-zinc-500">Leave blank to use model default. Some models only support 1.</div>
            </Field>
            <Field label="Max output tokens (optional)">
              <input
                type="number"
                min="1"
                placeholder="auto"
                value={maxCompletionTokens}
                onChange={(e) => setMaxCompletionTokens(e.target.value)}
                className="w-full rounded-xl border border-zinc-200 bg-white/60 p-2 font-mono text-sm shadow-sm outline-none focus:ring-2 focus:ring-indigo-300"
              />
            </Field>
            <div className="flex items-end gap-2">
              <Button variant="ghost" onClick={() => { setApiKey(""); }}>Clear Key</Button>
              <Button variant="ghost" onClick={() => { localStorage.clear(); location.reload(); }}>Reset App</Button>
            </div>
          </div>
          <div className="mt-3">
            <TextArea
              label="Instruction / Prompt (system)"
              value={systemPrompt}
              onChange={setSystemPrompt}
              rows={4}
              mono
              placeholder="Write the instructions you usually give ChatGPT..."
            />
          </div>
        </Card>

        <Card title="Source Text" subtitle="Original language">
          <TextArea
            value={sourceText}
            onChange={setSourceText}
            rows={12}
            placeholder="Paste the SOURCE text here (Hebrew or English)."
          />
        </Card>

        <Card title="Automated Translation" subtitle="Baseline to compare against">
          <TextArea
            value={autoText}
            onChange={setAutoText}
            rows={12}
            placeholder="Paste the automated translation here (the one you would normally edit)."
          />
        </Card>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button onClick={handleGenerate} disabled={busy}>
          {busy ? "Translating..." : "Generate GPT Translation"}
        </Button>
        <Button variant="ghost" onClick={handleCompareOnly} disabled={!autoText || !gptText}>
          Compare Only (use my GPT text)
        </Button>
        <Button variant="ghost" onClick={exportHTML} disabled={!autoText || !gptText}>
          Export HTML
        </Button>
        {error && <span className="text-sm text-rose-600">{error}</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card
          title="GPT Translation"
          subtitle="If API calls are blocked here, paste your GPT output manually."
          right={<Button variant="ghost" onClick={() => { navigator.clipboard.writeText(gptText || ""); }}>Copy</Button>}
        >
          <TextArea
            value={gptText}
            onChange={setGptText}
            rows={10}
            placeholder="GPT translation will appear here. Or paste manually."
          />
          <div className="mt-2 text-xs text-zinc-500">Tip: Cmd/Ctrl+Enter translates; you can then compare.</div>
        </Card>

        <Card title="Track Changes (Inline)" subtitle="Additions and deletions vs. the automated translation — editable" right={
          <div className="flex items-center gap-2">
            <Legend />
            <div className="hidden md:flex items-center gap-1">
              <button className={`px-2 py-1 text-xs rounded-lg border ${editorDirMode==='ltr'?'bg-zinc-200':'bg-white/70'} border-zinc-200`} onClick={()=>setEditorDirMode('ltr')}>LTR</button>
              <button className={`px-2 py-1 text-xs rounded-lg border ${editorDirMode==='rtl'?'bg-zinc-200':'bg-white/70'} border-zinc-200`} onClick={()=>setEditorDirMode('rtl')}>RTL</button>
              <button className={`px-2 py-1 text-xs rounded-lg border ${editorDirMode==='auto'?'bg-zinc-200':'bg-white/70'} border-zinc-200`} onClick={()=>setEditorDirMode('auto')}>Auto</button>
              <button className="px-2 py-1 text-xs rounded-lg border bg-white/70 border-zinc-200" onClick={()=>setRefreshTick(t=>t+1)}>Refresh</button>
            </div>
          </div>
        }>
          {!autoText || !gptText ? (
            <div className="text-sm text-zinc-500">Provide both the Automated Translation and GPT Translation to see differences.</div>
          ) : (
            <div className="max-h-[420px] overflow-auto rounded-2xl border border-zinc-100 bg-white/60 p-3">
              <InlineDiffEditor oldText={autoText} newText={gptText} onChange={setGptText} dir={resolvedEditorDir} refreshTick={refreshTick} />
            </div>
          )}
        </Card>

        <Card title="Side by Side" subtitle="Skim for bigger shifts">
          {!autoText && !gptText ? (
            <div className="text-sm text-zinc-500">Nothing to show yet.</div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-xs text-zinc-500">Automated</div>
                <div className="max-h-[380px] overflow-auto rounded-2xl border border-zinc-100 bg-white/60 p-3 whitespace-pre-wrap" dir="auto">{autoText}</div>
              </div>
              <div>
                <div className="mb-1 text-xs text-zinc-500">GPT</div>
                <div className="max-h-[380px] overflow-auto rounded-2xl border border-zinc-100 bg-white/60 p-3 whitespace-pre-wrap" dir="auto">{gptText}</div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card title="History" subtitle="Locally saved on this device (last 50)">
          {history.length === 0 ? (
            <div className="text-sm text-zinc-500">No history yet.</div>
          ) : (
            <ul className="max-h-[280px] overflow-auto divide-y divide-zinc-100">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between py-2">
                  <div>
                    <div className="text-sm font-medium">{fmtDate(h.date)}</div>
                    <div className="line-clamp-1 text-xs text-zinc-500">{(h.sourceText || "").slice(0, 140)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill>{h.kind}</Pill>
                    <Button variant="ghost" onClick={() => loadHistory(h)}>Load</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Shortcuts & Tips">
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
            <li><strong>Cmd/Ctrl + Enter</strong> — Generate GPT Translation.</li>
            <li><strong>Compare Only</strong> — Useful if you pasted a translation from elsewhere.</li>
            <li><strong>Export HTML</strong> — Saves a clean file with colors and strikethrough.</li>
            <li>Prompt accepts <code>{"{TARGET}"}</code> placeholder for language.</li>
          </ul>
        </Card>

        <SelfTestsPanel />
      </div>

      <script dangerouslySetInnerHTML={{ __html: `
        (function() {
          function handler(e){
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              const btn = document.querySelector('button'); // first button is Generate
              if (btn) btn.click();
            }
          }
          window.addEventListener('keydown', handler);
        })();
      `}} />
    </div>
  );
}
