-- ---------------------------------------------------------------------------
-- LGF - Employee: a third role on the People page.
--
-- An LGF employee is an affiliate in every way the app enforces — tracking
-- key, onboarding, earnings, scoping — so role stays 'affiliate' and this
-- column says which kind. See lib/roles.ts for why it is not a third value in
-- users.role: every access check in the app is written against that column,
-- and this role is not meant to change what anybody can see.
--
-- Meaningless on an admin, and cleared when somebody is made one.
--
-- Run this before the code that comes with it is deployed. Without it the
-- People page still lists everybody, as admin or affiliate, but choosing a
-- role or creating an LGF employee is refused with a line saying to run it.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------

alter table public.users
  add column if not exists lgf_employee boolean not null default false;

comment on column public.users.lgf_employee is
  'An affiliate who is an LGF employee. Shown as the role "LGF - Employee"; access is an affiliate''s.';
