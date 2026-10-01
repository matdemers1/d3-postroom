-- PST-T-16.26 (PST-REQ-200): how a session's second factor was satisfied. A session that signed in
-- with a recovery code is marked 'recovery_code' and must enrol a new TOTP secret before any
-- step-up-gated action; completing re-enrolment marks it 'totp'. Null for D3 Auth sessions and for
-- sessions issued before this column existed. Additive only.

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "second_factor" TEXT;

ALTER TABLE "session" ADD CONSTRAINT "session_second_factor" CHECK ("second_factor" IS NULL OR "second_factor" IN ('totp', 'recovery_code'));
