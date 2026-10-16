CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL, password_hash text NOT NULL,
  verified boolean NOT NULL DEFAULT false, plan text NOT NULL DEFAULT 'free',
  stripe_customer_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS email_tokens(
  token_hash text PRIMARY KEY, user_id uuid REFERENCES users ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS usage(
  user_id uuid REFERENCES users ON DELETE CASCADE, month text NOT NULL, count int NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, month));
CREATE TABLE IF NOT EXISTS runs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  language text NOT NULL, status text NOT NULL, attempts int NOT NULL,
  tests text NOT NULL, runner_output text, warnings jsonb, test_results jsonb,
  code_sha256 text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS runs_user_idx ON runs(user_id, created_at DESC);
