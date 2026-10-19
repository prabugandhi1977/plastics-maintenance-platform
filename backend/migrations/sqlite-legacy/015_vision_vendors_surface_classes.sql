-- Camera vendor (Hikvision, Keyence, Cognex…) for the edge capture adapter, and the surface class of an inspection
-- area (A visible / B partly visible / C hidden, as in VDA 16) that decides the acceptance limit for defects in it.
ALTER TABLE vision_cameras ADD COLUMN vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE vision_zones ADD COLUMN surface_class TEXT CHECK(surface_class IN ('A','B','C'));
