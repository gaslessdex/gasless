alter table public.gasless_token_registry
  add column if not exists name text,
  add column if not exists approved_dex_families jsonb not null default '[]'::jsonb,
  add column if not exists paused_capabilities jsonb not null default '[]'::jsonb,
  add column if not exists pricing_status text check (pricing_status in ('HEALTHY','UNAVAILABLE','STALE','DEVIATING')),
  add column if not exists pricing_source text,
  add column if not exists risk_limits jsonb not null default '{}'::jsonb,
  add column if not exists created_by text,
  add column if not exists updated_by text,
  add column if not exists audit_metadata jsonb not null default '{}'::jsonb;

alter table public.gasless_operator_audit
  add column if not exists operator text;
