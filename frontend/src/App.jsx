import { useEffect, useState } from "react";
const API = import.meta.env.VITE_API_URL || "";
async function api(path, opts = {}) {
  const r = await fetch(API + path, { credentials: "include", ...opts, headers: { "Content-Type": "application/json", "X-PPAI": "1" } });
  return r;
}
const json = async (path, method = "GET", body) => {
  const r = await api(path, { method, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.detail || "Request failed"), { status: r.status, data: d });
  return d;
};
const useHash = () => { const [h, s] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => s(location.hash.slice(1) || "/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h.split("?")[0]; };

export default function App() {
  const route = useHash(); const [me, setMe] = useState(null); const [cfg, setCfg] = useState({});
  const [dark, setDark] = useState(matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  const refresh = () => json("/api/me").then(setMe).catch(() => setMe(false));
  useEffect(() => { refresh(); json("/api/config").then(setCfg).catch(() => {}); }, [route]);
  const go = (p) => (location.hash = p);
  return (<>
    <header>
      <span className="logo">Persona<b>Pulse</b> AI</span>
      <span className="mut" title="Both the AI key and the sandbox key are configured on the server"><span className="dot" style={{ background: cfg.engine_ready ? "var(--ok)" : "var(--bad)" }} />{cfg.engine_ready ? "Engine ready" : "Engine not configured"}</span>
      <span className="sp" />
      {me && <><button className="link" onClick={() => go("/app")}>Studio</button><button className="link" onClick={() => go("/history")}>History</button>
        <button className="link" onClick={async () => { await json("/api/auth/logout", "POST"); setMe(false); go("/"); }}>Sign out</button></>}
      {me === false && <button className="link" onClick={() => go("/login")}>Sign in</button>}
      <button className="sec" onClick={() => setDark(!dark)} aria-label="Toggle theme">{dark ? "☀" : "☾"}</button>
    </header>
    <main>
      {route === "/login" && <Auth go={go} />}
      {route === "/app" && (me ? <Studio me={me} refresh={refresh} /> : me === false ? <Auth go={go} /> : null)}
      {route === "/history" && (me ? <History /> : <Auth go={go} />)}
      {!["/login", "/app", "/history"].includes(route) && <Landing cfg={cfg} go={go} />}
    </main></>);
}

function Landing({ cfg, go }) {
  return (<>
    <h1>Tests that run, and tests that mean something.</h1>
    <p className="mut">Paste code, describe the expected behavior, and get tests proven to run in an isolated sandbox, with assertions that actually check values.</p>
    <button className="pri" style={{ maxWidth: 260 }} onClick={() => go("/login")}>Start free</button>
    <h2>How it works</h2>
    <div className="grid">{[["1. Paste", "Pick Python or JavaScript, paste up to 20,000 characters, add business rules."], ["2. Generate and run", "Gemini writes tests; a quality gate rejects weak ones; they run in a sandbox with no network."], ["3. Trust the result", "Failures are fixed up to 3 times. If the code contradicts your rules, the test stays and is flagged POSSIBLE_BUG."]].map(([t, d]) => <div className="card" key={t}><b>{t}</b><p className="mut">{d}</p></div>)}</div>
    <h2>Pricing</h2>
    <div className="grid"><div className="card"><b>Free</b><p>{cfg.free_limit || 15} runs / month</p></div><div className="card"><b>Pro</b><p>{cfg.pro_limit || 300} runs / month</p></div></div>
    <h2>Privacy FAQ</h2>
    <details className="card"><summary>Is my code stored?</summary><p>No. We keep only the generated tests, status and a hash of your code, until you delete the run.</p></details>
    <details className="card"><summary>Is my code used to train models?</summary><p>{cfg.never_trained ? "Your code is never used to train models." : "Your code is sent to Google's Gemini API to generate tests. On the current AI plan we cannot promise it is excluded from model training, so don't paste secrets."}</p></details>
    <details className="card"><summary>Where does my code run?</summary><p>Only in a disposable sandbox with no network access, never on our servers.</p></details></>);
}

function Auth({ go }) {
  const [email, setE] = useState(""); const [password, setP] = useState(""); const [mode, setMode] = useState("login"); const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const submit = async () => { setErr(""); setMsg("");
    try { const d = await json(`/api/auth/${mode}`, "POST", { email, password });
      if (mode === "login") go("/app"); else setMsg(d.message); } catch (e) { setErr(e.message || "Check your email and a 10+ character password."); } };
  return (<div className="card" style={{ maxWidth: 420, margin: "0 auto" }}>
    <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
    {location.hash.includes("verified=1") && <p style={{ color: "var(--ok)" }}>Email verified. Please sign in.</p>}
    <label>Email</label><input value={email} onChange={(e) => setE(e.target.value)} type="email" />
    <label>Password (10+ characters)</label><input value={password} onChange={(e) => setP(e.target.value)} type="password" />
    {err && <div className="err">{err}</div>}{msg && <p>{msg}</p>}
    <button className="pri" onClick={submit}>{mode === "login" ? "Sign in" : "Sign up"}</button>
    <p><button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "New here? Create an account" : "Have an account? Sign in"}</button></p></div>);
}

function Studio({ me, refresh }) {
  const [language, setLang] = useState("python"); const [code, setCode] = useState(""); const [expected, setExp] = useState("");
  const [busy, setBusy] = useState(false); const [step, setStep] = useState(""); const [res, setRes] = useState(null); const [err, setErr] = useState(""); const [upgrade, setUpgrade] = useState(false);
  const left = me.remaining;
  const generate = async () => {
    setBusy(true); setErr(""); setRes(null); setStep("Writing tests...");
    try {
      const r = await api("/api/generate", { method: "POST", body: JSON.stringify({ language, code, expected }) });
      if (r.status === 402) { setUpgrade(true); return; }
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(typeof d.detail === "string" ? d.detail : "Please check your input (code up to 20,000 and expected behavior up to 3,000 characters)."); }
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "";
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const l of lines.filter(Boolean)) { const ev = JSON.parse(l);
          if (ev.type === "progress") setStep(ev.text); else if (ev.type === "result") setRes(ev); else if (ev.type === "error") setErr(ev.text); } }
    } catch (e) { setErr(e.message); } finally { setBusy(false); refresh(); }
  };
  const upgradeNow = async () => { const d = await json("/api/billing/checkout", "POST"); location.href = d.url; };
  if (upgrade || (left <= 0 && me.plan === "free")) return (<div className="card" style={{ textAlign: "center" }}>
    <h2>You've used all {me.limit} free runs this month</h2><p className="mut">Upgrade to Pro for {me.plan === "free" ? "a much higher monthly limit" : "more"}, or come back when your limit resets next month.</p>
    {me.plan === "free" && <button className="pri" style={{ maxWidth: 280 }} onClick={upgradeNow}>Upgrade to Pro</button>}</div>);
  const ext = language === "python" ? "py" : "js";
  return (<>
    <div className="card">
      <div className="row"><div><label>Language</label><select value={language} onChange={(e) => setLang(e.target.value)}><option value="python">Python (pytest)</option><option value="javascript">JavaScript (node:test)</option></select></div>
        <div style={{ textAlign: "right" }}><label>&nbsp;</label><b>{left} of {me.limit} left</b> <span className="mut">· {me.plan}</span></div></div>
      <label>Code ({code.length}/20000)</label><textarea className="code" value={code} maxLength={20000} onChange={(e) => setCode(e.target.value)} spellCheck={false} placeholder="Paste the code to test…" />
      <label>Expected behavior (optional, {expected.length}/3000)</label><textarea value={expected} maxLength={3000} rows={4} onChange={(e) => setExp(e.target.value)} placeholder="Business rules, edge cases, e.g. 'Discount never exceeds 50%; negative prices raise ValueError'" />
      <button className="pri" disabled={busy || !code.trim()} onClick={generate}>{busy ? step : "Generate Tests"}</button>
      {err && <div className="err">{err}</div>}
    </div>
    {res && <div className="card">
      <span className={"badge " + res.status}>{res.status.replaceAll("_", " ")}</span> <span className="mut">· {res.attempts} attempt(s)</span>
      {res.warnings.map((w, i) => <div className="warn" key={i}>⚠ {w}</div>)}
      <div className="row" style={{ margin: "12px 0" }}><button className="sec" style={{ flex: "none" }} onClick={() => navigator.clipboard.writeText(res.tests)}>Copy tests</button>
        <button className="sec" style={{ flex: "none" }} onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([res.tests])); a.download = language === "python" ? "test_subject.py" : "test_subject." + ext; a.click(); }}>Download</button></div>
      <pre>{res.tests}</pre>
      {res.test_results.map((t) => <div key={t.name}>{t.status === "passed" ? "✅" : t.status === "possible_bug" ? "🐞" : "❌"} {t.name}</div>)}
      <details style={{ marginTop: 12 }}><summary>Runner output</summary><pre>{res.runner_output || "(no output)"}</pre></details></div>}
  </>);
}

function History() {
  const [rows, setRows] = useState([]); const [open, setOpen] = useState(null);
  const load = () => json("/api/runs").then(setRows); useEffect(() => { load(); }, []);
  return (<div className="card"><h2>Run history</h2>{rows.length === 0 && <p className="mut">No runs yet.</p>}
    {rows.map((r) => <div key={r.id}><div className="hist"><span className={"badge " + r.status}>{r.status.replaceAll("_", " ")}</span><span>{r.language}</span><span className="mut">{new Date(r.created_at).toLocaleString()}</span><span className="sp" style={{ flex: 1 }} />
      <button className="sec" onClick={async () => setOpen(open?.id === r.id ? null : await json("/api/runs/" + r.id))}>View</button>
      <button className="sec" onClick={async () => { if (confirm("Delete this run?")) { await json("/api/runs/" + r.id, "DELETE"); load(); } }}>Delete</button></div>
      {open?.id === r.id && <pre>{open.tests}</pre>}</div>)}</div>);
}
