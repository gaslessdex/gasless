create table public.transaction_intents (
  id uuid primary key,
  wallet_address text not null,
  action_type text not null check (action_type in ('DEVNET_PROOF','CLEAN_CLAIM','CLEAN_RECOVER','CLEAN_BURN','SWAP','SEND')),
  network text not null check (network in ('devnet','mainnet-beta')),
  client_request_id text not null,
  request_id text not null,
  status text not null,
  quote_id uuid not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet_address, client_request_id)
);

create table public.transactions (
  id uuid primary key,
  intent_id uuid not null unique references public.transaction_intents(id),
  quote_id uuid not null unique,
  wallet_address text not null,
  action_type text not null,
  network text not null,
  status text not null,
  signature text unique,
  prepared_message_hash text not null,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_stage text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.transaction_events (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.transactions(id),
  event_type text not null,
  stage text not null,
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.accounting_entries (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.transactions(id),
  entry_type text not null,
  asset text not null,
  mint text,
  amount_raw numeric(78,0) not null,
  decimals smallint not null check (decimals between 0 and 30),
  amount_display numeric,
  created_at timestamptz not null default now(),
  unique (transaction_id, entry_type)
);

create table public.system_controls (
  control_key text primary key,
  enabled boolean not null,
  text_value text,
  updated_at timestamptz not null default now()
);

insert into public.system_controls (control_key, enabled) values
  ('global_execution', true), ('relayer', true), ('devnet', true), ('mainnet', false),
  ('clean', false), ('swap', false), ('send', false), ('devnet_proof', true);

create index transaction_intents_wallet_created_idx on public.transaction_intents (wallet_address, created_at desc);
create index transactions_wallet_created_idx on public.transactions (wallet_address, created_at desc);
create index transactions_status_updated_idx on public.transactions (status, updated_at);
create index transactions_signature_idx on public.transactions (signature) where signature is not null;
create index transaction_events_transaction_created_idx on public.transaction_events (transaction_id, created_at);

alter table public.transaction_intents enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_events enable row level security;
alter table public.accounting_entries enable row level security;
alter table public.system_controls enable row level security;

revoke all on public.transaction_intents, public.transactions, public.transaction_events, public.accounting_entries, public.system_controls from anon, authenticated;
revoke all on sequence public.transaction_events_id_seq, public.accounting_entries_id_seq from anon, authenticated;
grant all on public.transaction_intents, public.transactions, public.transaction_events, public.accounting_entries, public.system_controls to service_role;
grant usage, select on sequence public.transaction_events_id_seq, public.accounting_entries_id_seq to service_role;
