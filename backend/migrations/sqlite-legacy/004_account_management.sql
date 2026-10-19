-- Account management: a session version that invalidates existing sign-ins when a password is changed or reset,
-- and a flag asking users with a temporary password to choose their own.
ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
