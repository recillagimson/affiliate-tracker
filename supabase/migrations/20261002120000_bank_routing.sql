-- ---------------------------------------------------------------------------
-- The routing number on bank details.
--
-- An ACH payment needs the bank's 9-digit ABA routing number as well as the
-- account number, and bank_details never had one. Unlike the account number
-- it is not sealed: a routing number names a bank, not an account, and is
-- printed on every cheque that bank issues.
--
-- Rows saved before this have '' and count as incomplete in the app
-- (lib/onboarding-store), so those affiliates are asked for it by the same
-- "we still need your bank details" banner, and only have to type the routing
-- number: the sealed account number stays.
--
-- Safe to run twice.
-- ---------------------------------------------------------------------------
alter table public.bank_details
  add column if not exists routing_number text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bank_routing_shape'
  ) then
    alter table public.bank_details
      add constraint bank_routing_shape check (routing_number = '' or routing_number ~ '^[0-9]{9}$');
  end if;
end $$;
