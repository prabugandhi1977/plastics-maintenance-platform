-- Small compatibility functions for SQLite idioms still used in queries. Each returns exactly what SQLite returned,
-- so stored text formats and comparisons stay unchanged. Prefer native PostgreSQL in new code.

-- datetime('now') → 'YYYY-MM-DD HH:MM:SS' in UTC (SQLite format, no T and no Z).
CREATE OR REPLACE FUNCTION datetime(t text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN t = 'now' THEN to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
              ELSE to_char((t::timestamptz) AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS') END $$;

-- json_extract(doc, '$.a.b') → text value at that path (NULL when missing or not JSON).
CREATE OR REPLACE FUNCTION json_extract(doc text, path text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN doc::jsonb #>> string_to_array(regexp_replace(path, '^\$\.?', ''), '.');
EXCEPTION WHEN others THEN RETURN NULL;
END $$;

-- round(double precision, n): PostgreSQL only rounds NUMERIC to n places.
CREATE OR REPLACE FUNCTION round(x double precision, n integer) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT round(x::numeric, n)::double precision $$;
