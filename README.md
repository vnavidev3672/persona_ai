# Persona Pulse AI
1. `psql $DATABASE_URL -f backend/schema.sql`
2. Backend: `cd backend && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && copy .env.example .env` (fill in), then load env and run `uvicorn main:app --reload`. Deploy on Render/Fly/Railway (needs long-lived requests).
3. E2B: build a custom template with Python+pytest and Node preinstalled; set `E2B_TEMPLATE`. Network is disabled per run.
4. Frontend: `cd frontend && npm i && copy .env.example .env && npm run dev`; deploy to Vercel with `VITE_API_URL`. Cross-site cookies need `COOKIE_SAMESITE=none` on the API.
5. Stripe: create a recurring Price, set `STRIPE_PRICE_ID`, point a webhook at `/api/stripe/webhook` for checkout.session.completed and customer.subscription.updated/deleted.
