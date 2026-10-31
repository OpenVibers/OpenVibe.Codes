-- phase: expand
-- Codes L31 CH2: the reasoning effort a person chose for a turn (low, medium, high, xhigh or max on the shared ladder;
-- each agent gets the nearest level it accepts). Kept on the attempt beside its model, so the conversation can say
-- what each turn ran with. NULL is the agent's own default. No prompt, key or path is kept here.
ALTER TABLE codes_attempts ADD COLUMN IF NOT EXISTS effort text COLLATE "C";
