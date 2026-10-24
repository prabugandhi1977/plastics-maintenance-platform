-- Time-of-day tariffs per plant (Indian HT bills): ToD slots with a rate each, contract demand, a demand charge billed on
-- the higher of maximum demand and a share of contract demand, the demand interval and the power-factor rule.
-- Currency comes from the company. A plant without a row keeps the company's flat energy price.
CREATE TABLE energy_tariffs (
  plant_id TEXT PRIMARY KEY REFERENCES plants(id) DEFERRABLE INITIALLY IMMEDIATE,
  company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY IMMEDIATE,
  -- JSON [{band:'peak'|'normal'|'off_peak', start:'HH:MM', end:'HH:MM', rate}]: local times, covering 24 h exactly once.
  slots TEXT NOT NULL,
  contract_demand_kva DOUBLE PRECISION NOT NULL CHECK(contract_demand_kva > 0),
  demand_charge_per_kva DOUBLE PRECISION NOT NULL CHECK(demand_charge_per_kva >= 0),
  billing_demand_pct DOUBLE PRECISION NOT NULL DEFAULT 75 CHECK(billing_demand_pct BETWEEN 0 AND 100),
  demand_interval_minutes BIGINT NOT NULL DEFAULT 15 CHECK(demand_interval_minutes IN (15,30)),
  pf_target DOUBLE PRECISION NOT NULL DEFAULT 0.95 CHECK(pf_target > 0 AND pf_target <= 1),
  -- % of energy charges per full 0.01 of PF below (penalty) or above (incentive) the target.
  pf_penalty_pct DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK(pf_penalty_pct >= 0),
  pf_incentive_pct DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK(pf_incentive_pct >= 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_energy_tariffs_company ON energy_tariffs(company_id);

-- Optional electrical values per reading, averaged over the period: apparent power (kVA), reactive power (kvar) and
-- power factor. Maximum demand uses kVA when given, else derives it from kW with kvar or PF.
ALTER TABLE energy_readings ADD COLUMN kva DOUBLE PRECISION CHECK(kva >= 0);
ALTER TABLE energy_readings ADD COLUMN kvar DOUBLE PRECISION;
ALTER TABLE energy_readings ADD COLUMN pf DOUBLE PRECISION CHECK(pf > 0 AND pf <= 1);
