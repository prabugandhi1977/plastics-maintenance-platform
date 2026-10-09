-- Smart factory, stage 2: condition monitoring (limits per machine and parameter, readings, health) and energy.

-- Warning and critical limits per machine and monitored parameter (low and/or high). Critical raises a ticket when
-- auto_ticket is on.
CREATE TABLE IF NOT EXISTS sensor_limits (id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id), equipment_id TEXT NOT NULL REFERENCES equipment(id), parameter TEXT NOT NULL, warn_low REAL, warn_high REAL, crit_low REAL, crit_high REAL, auto_ticket INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, UNIQUE(equipment_id,parameter));

-- Condition readings in long form: one row per machine, parameter and time.
CREATE TABLE IF NOT EXISTS condition_readings (equipment_id TEXT NOT NULL REFERENCES equipment(id), parameter TEXT NOT NULL, observed_at TEXT NOT NULL, value REAL NOT NULL, company_id TEXT NOT NULL REFERENCES companies(id), source TEXT NOT NULL, PRIMARY KEY(equipment_id,parameter,observed_at));

-- Energy per machine and interval: kWh used and the highest power drawn.
CREATE TABLE IF NOT EXISTS energy_readings (equipment_id TEXT NOT NULL REFERENCES equipment(id), period_start TEXT NOT NULL, period_minutes INTEGER NOT NULL, kwh REAL NOT NULL, peak_kw REAL, company_id TEXT NOT NULL REFERENCES companies(id), source TEXT NOT NULL, PRIMARY KEY(equipment_id,period_start));

-- Energy price (company currency per kWh) and grid emission factor (kg CO2 per kWh); when empty, the national average
-- for the company's country is used for CO2 and cost is not shown.
ALTER TABLE companies ADD COLUMN energy_price_per_kwh REAL;
ALTER TABLE companies ADD COLUMN grid_co2_kg_per_kwh REAL;
