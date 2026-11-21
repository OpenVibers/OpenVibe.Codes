-- phase: expand
-- Spare usage nudges (plan §AD.37; the owner, 11-21: "detect your usage limit … use that on Watch or other platforms"):
-- the plan windows a person was already told about ("Codex: 70% of its week left, resets in 6 h; your spare list is
-- empty"), so each window is told once. Expand-only: one nullable column.
ALTER TABLE codes_spare_settings ADD COLUMN IF NOT EXISTS nudged jsonb;
