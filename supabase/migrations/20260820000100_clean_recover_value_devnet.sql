alter table public.transactions
  add column estimated_swap_output_lamports numeric(78,0),
  add column minimum_swap_output_lamports numeric(78,0),
  add column swap_service_fee_lamports numeric(78,0),
  add column rent_service_fee_lamports numeric(78,0),
  add column network_fee_lamports numeric(78,0),
  add column temporary_account_rent_lamports numeric(78,0);

insert into public.system_controls (control_key, enabled)
values ('recover', true)
on conflict (control_key) do update set enabled = excluded.enabled, updated_at = now();

create index transactions_recover_status_idx
  on public.transactions (status, updated_at)
  where action_type = 'CLEAN_RECOVER';
