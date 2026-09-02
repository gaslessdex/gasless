alter table public.transactions
  add column input_mint text,
  add column output_mint text,
  add column output_token_decimals smallint,
  add column routed_input_raw numeric(78,0),
  add column expected_output_raw numeric(78,0),
  add column minimum_output_raw numeric(78,0),
  add column actual_output_raw numeric(78,0),
  add column output_account text,
  add column output_ata_created boolean,
  add column output_ata_rent_lamports numeric(78,0),
  add column slippage_bps integer,
  add column price_impact_bps integer,
  add column route_fingerprint text;

insert into public.system_controls (control_key, enabled)
values ('swap', true)
on conflict (control_key) do update set enabled = excluded.enabled, updated_at = now();

create index transactions_swap_status_idx
  on public.transactions (status, updated_at)
  where action_type = 'SWAP';
