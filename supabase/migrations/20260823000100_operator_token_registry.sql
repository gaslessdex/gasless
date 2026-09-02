create table public.gasless_token_registry (
  network text not null check (network in ('devnet','mainnet-beta')),
  mint text not null,
  token_program text not null,
  symbol text not null,
  decimals smallint not null check (decimals between 0 and 30),
  extensions jsonb not null default '[]'::jsonb,
  status text not null check (status in ('PROPOSED','REVIEW','CANARY','ACTIVE','UNHEALTHY','PAUSED','REMOVED')),
  capabilities jsonb not null default '[]'::jsonb,
  paused boolean not null default true,
  treasury_ata text,
  operator_notes text,
  last_validation_status text,
  last_route_check_at timestamptz,
  pricing_available boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (network, mint, token_program)
);

create table public.gasless_operator_audit (
  id bigint generated always as identity primary key,
  network text not null check (network in ('devnet','mainnet-beta')),
  operation text not null,
  mint text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.gasless_token_registry enable row level security;
alter table public.gasless_operator_audit enable row level security;
revoke all on public.gasless_token_registry, public.gasless_operator_audit from anon, authenticated;
revoke all on sequence public.gasless_operator_audit_id_seq from anon, authenticated;
grant all on public.gasless_token_registry, public.gasless_operator_audit to service_role;
grant usage, select on sequence public.gasless_operator_audit_id_seq to service_role;
