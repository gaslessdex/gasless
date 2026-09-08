alter table public.transactions
  add column if not exists source_asset text,
  add column if not exists destination_chain_id bigint,
  add column if not exists destination_asset text,
  add column if not exists cross_chain_recipient text,
  add column if not exists relay_request_id text,
  add column if not exists relay_order_id text,
  add column if not exists quote_expires_at timestamptz,
  add column if not exists cross_chain_status text;

create index if not exists transactions_cross_chain_relay_request_idx
  on public.transactions (relay_request_id)
  where action_type = 'CROSS_CHAIN';
