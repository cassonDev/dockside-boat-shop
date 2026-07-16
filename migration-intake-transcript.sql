-- Adds the 3-layer intake record (transcript / original AI extraction / current
-- work-order fields) to work_orders. Run this once against your Supabase project
-- (SQL Editor -> paste -> Run) before deploying the updated app code.

alter table public.work_orders
  add column if not exists customer_concern text not null default '',
  add column if not exists original_transcript text not null default '',
  add column if not exists original_customer_concern text not null default '',
  add column if not exists original_extraction jsonb;

comment on column public.work_orders.customer_concern is 'Current editable customer-facing concern (service order / invoice / portal wording).';
comment on column public.work_orders.original_transcript is 'Speech-to-text transcript exactly as it existed when the job was saved. Permanently read-only after save.';
comment on column public.work_orders.original_customer_concern is 'First AI-generated customer-facing concern, preserved for audit even if customer_concern is later edited.';
comment on column public.work_orders.original_extraction is 'First AI-extracted field snapshot ({customerName, phone, boatYear, boatMake, boatModel, issue, customerConcern}), preserved for audit.';
