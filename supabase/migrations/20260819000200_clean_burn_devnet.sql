alter table public.transactions
  add column mint text,
  add column token_account text,
  add column token_amount_raw numeric(78,0),
  add column token_decimals smallint check (token_decimals between 0 and 30),
  add column mint_supply_raw numeric(78,0);

insert into public.system_controls (control_key, enabled)
values ('burn', true)
on conflict (control_key) do update set enabled = excluded.enabled, updated_at = now();

create index transactions_burn_status_idx on public.transactions (status, updated_at) where action_type = 'CLEAN_BURN';
