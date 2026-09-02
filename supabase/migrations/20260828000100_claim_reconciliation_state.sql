alter table public.transactions
  add column if not exists recent_blockhash text,
  add column if not exists last_valid_block_height bigint;

-- Existing indexes cover these read-only paths: quote_id and signature are
-- unique, and (status, updated_at) supports pending reconciliation scans.
