alter table public.transactions
  add column recipient_wallet text,
  add column destination_account text,
  add column recipient_ata_created boolean,
  add column recipient_amount_raw numeric(78,0),
  add column sponsor_reimbursement_raw numeric(78,0),
  add column service_fee_raw numeric(78,0),
  add column total_debit_raw numeric(78,0),
  add column ata_creation_lamports numeric(78,0),
  add column reimbursement_destination text,
  add column service_fee_destination text;

insert into public.system_controls (control_key, enabled)
values ('send', true)
on conflict (control_key) do update set enabled = excluded.enabled, updated_at = now();

create index transactions_send_status_idx
  on public.transactions (status, updated_at)
  where action_type = 'SEND';
