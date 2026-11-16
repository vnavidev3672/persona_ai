import { useEffect, useState, useCallback } from "react";
import "./styles.css";

const API = import.meta.env.VITE_API_URL || "";

// Core fetch with timeout + retry for Render cold starts
async function apiFetch(path, opts = {}, retries = 2) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
  try {
    const r = await fetch(API + path, {
      credentials: "include",
      signal: controller.signal,
      ...opts,
      headers: { "Content-Type": "application/json", "X-PPAI": "1", ...(opts.headers || {}) },
    });
    clearTimeout(timeout);
    return r;
  } catch (err) {
    clearTimeout(timeout);
    if (retries > 0 && (err.name === "TypeError" || err.name === "AbortError")) {
      // Render free tier cold start — wait 2s and retry
      await new Promise((res) => setTimeout(res, 2000));
      return apiFetch(path, opts, retries - 1);
    }
    throw err;
  }
}

const json = async (path, method = "GET", body) => {
  const r = await apiFetch(path, { method, body: body && JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.detail || "Request failed"), { status: r.status, data: d });
  return d;
};

const useHash = () => {
  const [h, s] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const f = () => s(location.hash.slice(1) || "/");
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return h.split("?")[0];
};

// ── Root App ──────────────────────────────────────────────
export default function App() {
  const route = useHash();
  const [me, setMe] = useState(null);
  const [cfg, setCfg] = useState({});
  const [dark, setDark] = useState(matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const refresh = useCallback(() =>
    json("/api/me").then(setMe).catch(() => setMe(false)), []);

  useEffect(() => {
    refresh();
    json("/api/config").then(setCfg).catch(() => {});
  }, [route]);

  const go = (p) => (location.hash = p);

  return (
    <>
      <header>
        <span className="logo" onClick={() => go("/")} style={{ cursor: "pointer" }}>
          Persona<b>Pulse</b> AI
        </span>
        <span className="mut" style={{ fontSize: 13 }} title="AI engine status">
          <span
            className="dot"
            style={{ background: cfg.engine_ready ? "var(--ok)" : "var(--bad)" }}
          />
          {cfg.engine_ready ? "Engine ready" : "Engine not configured"}
        </span>
        <span className="sp" />
        {me && (
          <>
            <button className="link" onClick={() => go("/app")}>Studio</button>
            <button className="link" onClick={() => go("/history")}>History</button>
            <button
              className="link"
              onClick={async () => {
                await json("/api/auth/logout", "POST");
                setMe(false);
                go("/");
              }}
            >
              Sign out
            </button>
          </>
        )}
        {me === false && (
          <button className="link" onClick={() => go("/login")}>Sign in</button>
        )}
        <button
          className="sec"
          onClick={() => setDark(!dark)}
          aria-label="Toggle theme"
          style={{ padding: "6px 10px", fontSize: 16 }}
        >
          {dark ? "☀" : "☾"}
        </button>
      </header>

      <main>
        {route === "/login" && <Auth go={go} />}
        {route === "/app" && (me ? <Studio me={me} refresh={refresh} /> : me === false ? <Auth go={go} /> : null)}
        {route === "/history" && (me ? <History /> : <Auth go={go} />)}
        {!["/login", "/app", "/history"].includes(route) && <Landing cfg={cfg} go={go} />}
      </main>
    </>
  );
}

// ── Landing ───────────────────────────────────────────────
function Landing({ cfg, go }) {
  return (
    <>
      <div className="hero-section">
        <p className="section-label">AI-Powered Testing</p>
        <h1>Tests that run, and tests that mean something.</h1>
        <p className="mut">
          Paste code, describe the expected behavior, and get tests proven to run in an
          isolated sandbox — with assertions that actually check values.
        </p>
        <button className="pri" onClick={() => go("/login")}>
          Start free →
        </button>
      </div>

      <p className="section-label">How it works</p>
      <div className="grid">
        {[
          ["🔍", "1. Paste", "Pick Python or JavaScript, paste up to 20,000 characters, add business rules."],
          ["⚡", "2. Generate & Run", "Gemini writes tests; a quality gate rejects weak ones; they run in a sandbox with no network."],
          ["✅", "3. Trust the result", "Failures are fixed up to 3 times. If the code contradicts your rules, the test stays and is flagged POSSIBLE_BUG."],
        ].map(([icon, t, d]) => (
          <div className="card" key={t}>
            <div style={{ fontSize: 28, marginBottom: 10 }}>{icon}</div>
            <b style={{ fontSize: 16 }}>{t}</b>
            <p className="mut" style={{ marginTop: 6 }}>{d}</p>
          </div>
        ))}
      </div>

      <p className="section-label">Pricing</p>
      <div className="grid">
        <div className="card">
          <b style={{ fontSize: 17 }}>Free</b>
          <p style={{ marginTop: 6 }}>{cfg.free_limit || 15} runs / month</p>
          <p className="mut">Everything you need to get started</p>
        </div>
        <div className="card">
          <b style={{ fontSize: 17 }}>Pro</b>
          <p style={{ marginTop: 6 }}>{cfg.pro_limit || 300} runs / month</p>
          <p className="mut">For teams and power users</p>
        </div>
      </div>

      <p className="section-label">Privacy FAQ</p>
      <details className="card">
        <summary>Is my code stored?</summary>
        <p className="mut" style={{ marginTop: 8 }}>
          No. We keep only the generated tests, status and a hash of your code, until you delete the run.
        </p>
      </details>
      <details className="card">
        <summary>Is my code used to train models?</summary>
        <p className="mut" style={{ marginTop: 8 }}>
          {cfg.never_trained
            ? "Your code is never used to train models."
            : "Your code is sent to Google's Gemini API to generate tests. On the current AI plan we cannot promise it is excluded from model training, so don't paste secrets."}
        </p>
      </details>
      <details className="card">
        <summary>Where does my code run?</summary>
        <p className="mut" style={{ marginTop: 8 }}>
          Only in a disposable sandbox with no network access, never on our servers.
        </p>
      </details>
    </>
  );
}

// ── Auth ──────────────────────────────────────────────────
function Auth({ go }) {
  const [email, setE] = useState("");
  const [password, setP] = useState("");
  const [mode, setMode] = useState("login");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const isRegister = mode === "register";

  const submit = async () => {
    setErr(""); setMsg(""); setLoading(true);
    try {
      const d = await json(`/api/auth/${mode}`, "POST", { email, password });
      if (mode === "login") {
        go("/app");
      } else {
        // Show success and auto-switch to login if auto-verified
        const autoVerified = d.auto_verified;
        setMsg(d.message || "Check your inbox for a verification link.");
        if (autoVerified) {
          setTimeout(() => {
            setMode("login");
            setMsg("Account ready! Please sign in.");
          }, 1500);
        }
      }
    } catch (e) {
      if (e.message === "Failed to fetch" || e.name === "TypeError" || e.name === "AbortError") {
        setErr("Could not reach the server. It may be waking up — please wait a moment and try again.");
      } else {
        setErr(e.message || "Check your email and use a 10+ character password.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="card auth-card">
      <div className="auth-icon">{isRegister ? "✨" : "🔑"}</div>
      <h2 style={{ marginBottom: 4 }}>{isRegister ? "Create account" : "Welcome back"}</h2>
      <p className="mut" style={{ marginBottom: 8 }}>
        {isRegister ? "Join PersonaPulse AI — it's free." : "Sign in to your PersonaPulse AI account."}
      </p>

      {location.hash.includes("verified=1") && (
        <div className="msg-ok">✓ Email verified. Please sign in.</div>
      )}

      <label htmlFor="auth-email">Email</label>
      <input
        id="auth-email"
        value={email}
        onChange={(e) => setE(e.target.value)}
        onKeyDown={handleKey}
        type="email"
        placeholder="you@example.com"
        autoComplete="email"
      />

      <label htmlFor="auth-pass">Password {isRegister && <span className="mut">(10+ characters)</span>}</label>
      <input
        id="auth-pass"
        value={password}
        onChange={(e) => setP(e.target.value)}
        onKeyDown={handleKey}
        type="password"
        placeholder={isRegister ? "Choose a strong password" : "Your password"}
        autoComplete={isRegister ? "new-password" : "current-password"}
      />

      {err && <div className="err">⚠ {err}</div>}
      {msg && <div className="msg-ok">✓ {msg}</div>}

      <button className="pri" onClick={submit} disabled={loading || !email || !password}>
        {loading ? (
          <><span className="spinner" />{isRegister ? "Creating account…" : "Signing in…"}</>
        ) : (
          isRegister ? "Sign up" : "Sign in"
        )}
      </button>

      <p style={{ textAlign: "center", marginTop: 16 }}>
        <button
          className="link"
          onClick={() => { setMode(isRegister ? "login" : "register"); setErr(""); setMsg(""); }}
        >
          {isRegister ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
      </p>
    </div>
  );
}

// ── Studio ────────────────────────────────────────────────
function Studio({ me, refresh }) {
  const [language, setLang] = useState("python");
  const [code, setCode] = useState("");
  const [expected, setExp] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const [upgrade, setUpgrade] = useState(false);

  const left = me.remaining;

  const generate = async () => {
    setBusy(true); setErr(""); setRes(null); setStep("Writing tests…");
    try {
      const r = await apiFetch("/api/generate", {
        method: "POST",
        body: JSON.stringify({ language, code, expected }),
      });
      if (r.status === 402) { setUpgrade(true); return; }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(
          typeof d.detail === "string"
            ? d.detail
            : "Please check your input (code up to 20,000 and expected behavior up to 3,000 characters)."
        );
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const l of lines.filter(Boolean)) {
          const ev = JSON.parse(l);
          if (ev.type === "progress") setStep(ev.text);
          else if (ev.type === "result") setRes(ev);
          else if (ev.type === "error") setErr(ev.text);
        }
      }
    } catch (e) {
      if (e.message === "Failed to fetch" || e.name === "TypeError") {
        setErr("Could not reach the server — it may still be waking up. Please try again.");
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy(false); refresh();
    }
  };

  const upgradeNow = async () => {
    const d = await json("/api/billing/checkout", "POST");
    location.href = d.url;
  };

  if (upgrade || (left <= 0 && me.plan === "free")) {
    return (
      <div className="card" style={{ textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🚀</div>
        <h2>You've used all {me.limit} free runs this month</h2>
        <p className="mut" style={{ marginTop: 8, marginBottom: 20 }}>
          Upgrade to Pro for a much higher monthly limit, or come back when your limit resets.
        </p>
        {me.plan === "free" && (
          <button className="pri" style={{ maxWidth: 280, margin: "0 auto" }} onClick={upgradeNow}>
            Upgrade to Pro
          </button>
        )}
      </div>
    );
  }

  const ext = language === "python" ? "py" : "js";

  return (
    <>
      <div className="card">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div>
            <label>Language</label>
            <select value={language} onChange={(e) => setLang(e.target.value)}>
              <option value="python">Python (pytest)</option>
              <option value="javascript">JavaScript (node:test)</option>
            </select>
          </div>
          <div style={{ textAlign: "right" }}>
            <label>&nbsp;</label>
            <div>
              <b style={{ fontSize: 16 }}>{left}</b>
              <span className="mut"> of {me.limit} runs left · {me.plan}</span>
            </div>
          </div>
        </div>

        <label>Code ({code.length}/20000)</label>
        <textarea
          className="code"
          value={code}
          maxLength={20000}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          placeholder="Paste the code to test…"
        />

        <label>Expected behavior <span className="mut">(optional, {expected.length}/3000)</span></label>
        <textarea
          value={expected}
          maxLength={3000}
          rows={4}
          onChange={(e) => setExp(e.target.value)}
          placeholder="Business rules, edge cases, e.g. 'Discount never exceeds 50%; negative prices raise ValueError'"
        />

        <button className="pri" disabled={busy || !code.trim()} onClick={generate}>
          {busy ? <><span className="spinner" />{step}</> : "Generate Tests ⚡"}
        </button>

        {err && <div className="err">⚠ {err}</div>}
      </div>

      {res && (
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span className={"badge " + res.status}>{res.status.replaceAll("_", " ")}</span>
            <span className="mut">· {res.attempts} attempt(s)</span>
          </div>
          {res.warnings.map((w, i) => <div className="warn" key={i}>⚠ {w}</div>)}
          <div className="row" style={{ margin: "12px 0" }}>
            <button className="sec" style={{ flex: "none" }}
              onClick={() => navigator.clipboard.writeText(res.tests)}>
              📋 Copy tests
            </button>
            <button className="sec" style={{ flex: "none" }}
              onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([res.tests]));
                a.download = language === "python" ? "test_subject.py" : "test_subject." + ext;
                a.click();
              }}>
              ⬇ Download
            </button>
          </div>
          <pre>{res.tests}</pre>
          <div style={{ marginTop: 12 }}>
            {res.test_results.map((t) => (
              <div key={t.name} style={{ padding: "4px 0" }}>
                {t.status === "passed" ? "✅" : t.status === "possible_bug" ? "🐞" : "❌"} {t.name}
              </div>
            ))}
          </div>
          <details style={{ marginTop: 12 }}>
            <summary>Runner output</summary>
            <pre>{res.runner_output || "(no output)"}</pre>
          </details>
        </div>
      )}
    </>
  );
}

// ── History ───────────────────────────────────────────────
function History() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const load = () => json("/api/runs").then(setRows);
  useEffect(() => { load(); }, []);

  return (
    <div className="card">
      <h2 style={{ marginBottom: 16 }}>Run history</h2>
      {rows.length === 0 && <p className="mut">No runs yet. Head to Studio to generate your first tests!</p>}
      {rows.map((r) => (
        <div key={r.id}>
          <div className="hist">
            <span className={"badge " + r.status}>{r.status.replaceAll("_", " ")}</span>
            <span style={{ fontWeight: 500 }}>{r.language}</span>
            <span className="mut">{new Date(r.created_at).toLocaleString()}</span>
            <span className="sp" style={{ flex: 1 }} />
            <button
              className="sec"
              onClick={async () => setOpen(open?.id === r.id ? null : await json("/api/runs/" + r.id))}
            >
              {open?.id === r.id ? "Hide" : "View"}
            </button>
            <button
              className="sec"
              onClick={async () => {
                if (confirm("Delete this run?")) { await json("/api/runs/" + r.id, "DELETE"); load(); }
              }}
            >
              Delete
            </button>
          </div>
          {open?.id === r.id && <pre>{open.tests}</pre>}
        </div>
      ))}
    </div>
  );
}
