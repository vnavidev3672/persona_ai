import os, json, time, queue, threading, secrets, hashlib, smtplib, logging, httpx
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Literal, Optional
import bcrypt, jwt, stripe
from fastapi import FastAPI, Request, Response, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, RedirectResponse
# pyrefly: ignore[missing-import]
from psycopg.rows import dict_row
# pyrefly: ignore[import-unresolved]
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, EmailStr, Field
import pipeline, sandbox

E = os.environ
log = logging.getLogger("ppai")
pool = ConnectionPool(
    E["DATABASE_URL"],
    kwargs={"row_factory": dict_row},
    min_size=0,
    max_size=10,
    max_idle=60,
    check=ConnectionPool.check_connection,
    open=True,
)
stripe.api_key = E.get("STRIPE_SECRET_KEY", "")
LIMITS = {"free": int(E.get("FREE_RUNS_PER_MONTH", 15)), "pro": int(E.get("PRO_RUNS_PER_MONTH", 300))}
SECURE = E.get("ENV") != "dev"

app = FastAPI(title="Persona Pulse AI")
app.add_middleware(CORSMiddleware, allow_origins=[E["APP_URL"]], allow_credentials=True,
                   allow_methods=["GET", "POST", "DELETE"], allow_headers=["Content-Type", "X-PPAI", "Authorization"])

def q(sql, *args, one=False, all_=False):
    for attempt in range(2):
        try:
            with pool.connection() as c:
                cur = c.execute(sql, args)
                return cur.fetchone() if one else cur.fetchall() if all_ else None
        except Exception as e:
            if attempt == 0:
                log.warning("Database query retry on error: %s", e)
                continue
            raise

# ---------- rate limiting (in-memory; swap for Redis if you run >1 instance) ----------
_hits = defaultdict(deque)
def limit(key, n, per=60):
    now, d = time.time(), _hits[key]
    while d and d[0] < now - per: d.popleft()
    if len(d) >= n: raise HTTPException(429, "Too many requests. Please slow down and try again shortly.")
    d.append(now)

def ip_of(r: Request):
    return (r.headers.get("x-forwarded-for", "").split(",")[0].strip() or r.client.host)  # trust only behind your proxy

@app.middleware("http")
async def guard(request: Request, call_next):
    try:
        limit("ip:" + ip_of(request), 120)
        if request.method in ("POST", "DELETE") and not request.url.path.endswith("/stripe/webhook") \
                and request.headers.get("x-ppai") != "1":
            return JSONResponse({"detail": "Missing header"}, 400)  # CSRF: forces a CORS preflight
        return await call_next(request)
    except HTTPException as e:
        return JSONResponse({"detail": e.detail}, e.status_code)
    except Exception as e:
        log.exception("Unhandled server error: %s", e)
        resp = JSONResponse({"detail": f"Server error: {str(e)}"}, 500)
        origin = request.headers.get("origin")
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
        return resp

@app.on_event("startup")
def init_db():
    try:
        schema_path = os.path.join(os.path.dirname(__file__), "schema.sql")
        if os.path.exists(schema_path):
            with open(schema_path) as f:
                sql = f.read()
            with pool.connection() as c:
                c.execute(sql)
            log.info("Database schema verified/initialized successfully.")
    except Exception as e:
        log.exception("DB init error: %s", e)

@app.get("/api/health")
def health():
    db_ok = False
    db_err = None
    try:
        with pool.connection() as c:
            c.execute("SELECT 1")
            db_ok = True
    except Exception as e:
        db_err = str(e)
    gemini_key = E.get("GEMINI_API_KEY", "").strip()
    key_prefix = gemini_key[:6] + "..." + gemini_key[-4:] if len(gemini_key) > 10 else "missing"
    ai_probe = "untested"
    gen_probe = "untested"
    if gemini_key:
        try:
            r = httpx.get(f"https://generativelanguage.googleapis.com/v1beta/models?key={gemini_key}", timeout=10)
            if r.status_code == 200:
                available = [m["name"].replace("models/", "") for m in r.json().get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]
                ai_probe = f"ok, available models: {available[:6]}"
            else:
                ai_probe = f"HTTP {r.status_code}: {r.text[:250]}"
        except Exception as ex:
            ai_probe = f"probe error: {ex}"
        try:
            t_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={gemini_key}"
            t_r = httpx.post(t_url, json={"contents": [{"parts": [{"text": "hi"}]}]}, timeout=10)
            gen_probe = f"HTTP {t_r.status_code}: {t_r.text[:300]}"
        except Exception as ex:
            gen_probe = f"post error: {ex}"
    modal_ok = bool(E.get("MODAL_TOKEN_ID") and E.get("MODAL_TOKEN_SECRET"))
    return {"status": "ok", "database": db_ok, "db_error": db_err, "key_prefix": key_prefix, "ai_probe": ai_probe, "gen_probe": gen_probe, "modal_configured": modal_ok}


# ---------- auth ----------
def make_token(uid): return jwt.encode({"sub": str(uid), "exp": datetime.now(timezone.utc) + timedelta(days=14)}, E["JWT_SECRET"], "HS256")

def user_dep(request: Request):
    tok = request.cookies.get("ppai_session")
    auth_hdr = request.headers.get("authorization")
    if not tok and auth_hdr and auth_hdr.startswith("Bearer "):
        tok = auth_hdr[7:]
    try: uid = jwt.decode(tok, E["JWT_SECRET"], ["HS256"])["sub"]
    except Exception: raise HTTPException(401, "Please sign in.")
    u = q("SELECT * FROM users WHERE id=%s", uid, one=True)
    if not u or not u["verified"]: raise HTTPException(401, "Please sign in.")
    return u

class Creds(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)

def send_mail(to, subject, body):
    """Send an email. Returns True on success, False if SMTP not configured."""
    if not E.get("SMTP_HOST"):
        log.warning("SMTP not configured – skipping email to %s: %s", to, body)
        return False
    m = EmailMessage(); m["To"], m["From"], m["Subject"] = to, E.get("SMTP_FROM", "no-reply@example.com"), subject; m.set_content(body)
    with smtplib.SMTP(E["SMTP_HOST"], int(E.get("SMTP_PORT", 587))) as s:
        s.starttls(); s.login(E["SMTP_USER"], E["SMTP_PASS"]); s.send_message(m)
    return True

@app.post("/api/auth/register", status_code=202)
def register(c: Creds, response: Response):
    email = c.email.lower()
    h = bcrypt.hashpw(c.password.encode(), bcrypt.gensalt()).decode()
    u = q("INSERT INTO users(email,password_hash) VALUES(%s,%s) ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id, verified",
          email, h, one=True)
    if not u["verified"]:
        smtp_configured = bool(E.get("SMTP_HOST"))
        if smtp_configured:
            # Send verification email
            raw = secrets.token_urlsafe(32)
            q("INSERT INTO email_tokens VALUES(%s,%s,now()+interval '1 day') ON CONFLICT DO NOTHING",
              hashlib.sha256(raw.encode()).hexdigest(), u["id"])
            send_mail(email, "Verify your Persona Pulse AI account",
                      f"Verify: {E['API_URL']}/api/auth/verify?token={raw}")
            return {"message": "Check your inbox for a verification link.", "email_sent": True}
        else:
            # No SMTP configured – auto-verify so users can actually log in
            q("UPDATE users SET verified=true WHERE id=%s", u["id"])
            return {"message": "Account created! You can now sign in.", "email_sent": False, "auto_verified": True}
    return {"message": "Account already exists. Please sign in.", "email_sent": False}

@app.get("/api/auth/verify")
def verify(token: str):
    r = q("DELETE FROM email_tokens WHERE token_hash=%s AND expires_at>now() RETURNING user_id",
          hashlib.sha256(token.encode()).hexdigest(), one=True)
    if r: q("UPDATE users SET verified=true WHERE id=%s", r["user_id"])
    return RedirectResponse(f"{E['APP_URL']}/#/login?verified={1 if r else 0}")

@app.post("/api/auth/login")
def login(c: Creds, request: Request, response: Response):
    limit("login:" + ip_of(request), 10)
    u = q("SELECT * FROM users WHERE email=%s", c.email.lower(), one=True)
    if not u or not bcrypt.checkpw(c.password.encode(), u["password_hash"].encode()):
        raise HTTPException(401, "Wrong email or password.")
    if not u["verified"]: raise HTTPException(403, "Please verify your email first.")
    token = make_token(u["id"])
    cookie_samesite = E.get("COOKIE_SAMESITE", "none" if SECURE else "lax")
    response.set_cookie("ppai_session", token, httponly=True, secure=SECURE,
                        samesite=cookie_samesite, max_age=14 * 86400)
    return {"ok": True, "token": token}

@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie("ppai_session"); return {"ok": True}

# ---------- usage ----------
def month(): return datetime.now(timezone.utc).strftime("%Y-%m")
def used(uid):
    r = q("SELECT count FROM usage WHERE user_id=%s AND month=%s", uid, month(), one=True)
    return r["count"] if r else 0

@app.get("/api/me")
def me(u=Depends(user_dep)):
    lim, n = LIMITS[u["plan"]], used(u["id"])
    return {"email": u["email"], "plan": u["plan"], "used": n, "limit": lim, "remaining": max(lim - n, 0)}

@app.get("/api/config")
def config():
    return {"free_limit": LIMITS["free"], "pro_limit": LIMITS["pro"], "never_trained": E.get("AI_PAID_TIER") == "true",
            "engine_ready": bool(E.get("GEMINI_API_KEY"))}

# ---------- generate ----------
class GenReq(BaseModel):
    language: Literal["python", "javascript"]
    code: str = Field(min_length=1, max_length=20000)
    expected: str = Field("", max_length=3000)

@app.post("/api/generate")
def generate(req: GenReq, u=Depends(user_dep)):
    limit("gen:" + str(u["id"]), 5)
    lim = LIMITS[u["plan"]]
    # Atomic server-side gate: increments only if still under the limit.
    row = q("INSERT INTO usage(user_id,month,count) VALUES(%s,%s,1) ON CONFLICT(user_id,month) DO UPDATE SET count=usage.count+1 "
            "WHERE usage.count<%s RETURNING count", u["id"], month(), lim, one=True)
    if not row:
        return JSONResponse({"error": "limit_reached", "plan": u["plan"], "used": lim, "limit": lim}, 402)
    events: "queue.Queue" = queue.Queue()

    def work():
        try:
            res = pipeline.run(req.language, req.code, req.expected, lambda t: events.put({"type": "progress", "text": t}))
            rid = q("INSERT INTO runs(user_id,language,status,attempts,tests,runner_output,warnings,test_results,code_sha256) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id", u["id"], req.language, res["status"], res["attempts"],
                    res["tests"], res["runner_output"], json.dumps(res["warnings"]), json.dumps(res["test_results"]),
                    res["code_sha256"], one=True)["id"]
            events.put({"type": "result", "id": str(rid), **res, "used": row["count"], "limit": lim})
        except Exception as e:
            q("UPDATE usage SET count=GREATEST(count-1,0) WHERE user_id=%s AND month=%s", u["id"], month())  # refund infra failures
            log.exception("run failed: %s", e)
            err_msg = str(e)
            if isinstance(e, pipeline.AIRateLimited):
                msg = "The AI service is busy right now (rate limit). Please try again in a minute. This run was not counted."
            elif isinstance(e, (pipeline.AIUnavailable, sandbox.SandboxUnavailable)):
                msg = f"Service temporarily unavailable: {err_msg}. This run was not counted."
            else:
                msg = f"Error ({type(e).__name__}): {err_msg}. This run was not counted."
            events.put({"type": "error", "text": msg})
        events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream():
        while (ev := events.get()) is not None:
            yield json.dumps(ev) + "\n"
    return StreamingResponse(stream(), media_type="application/x-ndjson")

# ---------- history ----------
@app.get("/api/runs")
def runs(u=Depends(user_dep)):
    return q("SELECT id,language,status,attempts,created_at FROM runs WHERE user_id=%s ORDER BY created_at DESC LIMIT 100", u["id"], all_=True)

@app.get("/api/runs/{rid}")
def run_one(rid: str, u=Depends(user_dep)):
    r = q("SELECT * FROM runs WHERE id=%s AND user_id=%s", rid, u["id"], one=True)
    if not r: raise HTTPException(404, "Not found")
    return r

@app.delete("/api/runs/{rid}")
def run_del(rid: str, u=Depends(user_dep)):
    q("DELETE FROM runs WHERE id=%s AND user_id=%s", rid, u["id"]); return {"ok": True}

# ---------- billing ----------
@app.post("/api/billing/checkout")
def checkout(u=Depends(user_dep)):
    s = stripe.checkout.Session.create(mode="subscription", line_items=[{"price": E["STRIPE_PRICE_ID"], "quantity": 1}],
        client_reference_id=str(u["id"]), customer_email=None if u["stripe_customer_id"] else u["email"],
        customer=u["stripe_customer_id"] or None, success_url=E["APP_URL"] + "/#/app?upgraded=1", cancel_url=E["APP_URL"] + "/#/app")
    return {"url": s.url}

@app.post("/api/stripe/webhook")
async def webhook(request: Request):
    try:
        ev = stripe.Webhook.construct_event(await request.body(), request.headers.get("stripe-signature", ""), E["STRIPE_WEBHOOK_SECRET"])
    except Exception:
        raise HTTPException(400, "Bad signature")
    t, o = ev["type"], ev["data"]["object"]
    if t == "checkout.session.completed" and o.get("client_reference_id"):
        q("UPDATE users SET plan='pro', stripe_customer_id=%s WHERE id=%s", o["customer"], o["client_reference_id"])
    elif t in ("customer.subscription.updated", "customer.subscription.deleted"):
        plan = "pro" if o["status"] in ("active", "trialing") and t.endswith("updated") else "free"
        q("UPDATE users SET plan=%s WHERE stripe_customer_id=%s", plan, o["customer"])
    return {"received": True}
