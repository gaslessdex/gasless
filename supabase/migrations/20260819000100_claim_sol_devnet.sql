alter table public.transactions drop constraint if exists transactions_intent_id_key;
alter table public.transactions drop constraint if exists transactions_quote_id_key;

alter table public.transactions
  add column batch_index integer not null default 0 check (batch_index >= 0),
  add column account_addresses jsonb,
  add column gross_recovered_lamports numeric(78,0),
  add column gasless_fee_lamports numeric(78,0),
  add column sponsored_cost_lamports numeric(78,0),
  add column net_user_lamports numeric(78,0),
  add column relayer_address text,
  add column fee_destination text,
  add constraint transactions_intent_batch_key unique (intent_id, batch_index),
  add constraint transactions_quote_batch_key unique (quote_id, batch_index);

insert into public.system_controls (control_key, enabled)
values ('claim', true)
on conflict (control_key) do update set enabled = excluded.enabled, updated_at = now();

update public.system_controls set enabled = true, updated_at = now() where control_key = 'clean';

create index transactions_claim_status_idx
  on public.transactions (status, updated_at)
  where action_type = 'CLEAN_CLAIM';
