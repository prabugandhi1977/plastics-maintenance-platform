"""Per-frame decisions for the four vision modules, from model detections to incidents.

The GPU pipeline (pipeline.py) turns each frame into detections: a class label, a confidence and a box in
image coordinates normalised to 0..1, plus a tracker id that follows the same object across frames. These
functions decide what those detections mean against the camera's configuration from the platform (required
PPE, zones, quality preset). They are pure and deterministic so they behave the same in tests and on the line.
"""
from dataclasses import dataclass, field
from typing import Optional

# ---------- Geometry ----------

def point_in_polygon(x, y, poly):
    """Ray casting; poly is [[x, y], ...] normalised to 0..1."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def foot_point(box):
    """Where a person or vehicle touches the floor: the bottom centre of its box."""
    return box["x"] + box["w"] / 2, box["y"] + box["h"]


def _side(p, a, b):
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def crossed(prev, cur, line):
    """True when the movement prev -> cur crosses the tripwire segment line=[a, b]."""
    a, b = line
    if _side(prev, a, b) * _side(cur, a, b) >= 0:
        return False
    return _side(a, prev, cur) * _side(b, prev, cur) < 0


@dataclass
class Detection:
    label: str                 # person, vehicle, helmet, vest, goggles, boots, fire, smoke, or a defect class
    confidence: float
    box: dict                  # {"x","y","w","h"} normalised
    track_id: Optional[int] = None
    attributes: dict = field(default_factory=dict)   # e.g. size_px for defects


# ---------- PPE ----------

GEAR_REGION = {"helmet": (0.0, 0.3), "goggles": (0.0, 0.3), "vest": (0.2, 0.75), "boots": (0.75, 1.0)}


def _gear_on_person(person, gear, kind):
    """A gear detection counts for a person when its centre lies in the expected band of the person's box
    (helmet and goggles at the head, vest on the torso, boots at the feet)."""
    lo, hi = GEAR_REGION[kind]
    gx, gy = gear.box["x"] + gear.box["w"] / 2, gear.box["y"] + gear.box["h"] / 2
    p = person.box
    return p["x"] <= gx <= p["x"] + p["w"] and p["y"] + lo * p["h"] <= gy <= p["y"] + hi * p["h"]


def ppe_check(detections, required, min_confidence=0.6, zone=None):
    """Returns [(person, missing_gear)] for people in the (optional) PPE zone who lack required gear.
    People detected below min_confidence are not judged (they are checked again on the next frames)."""
    people = [d for d in detections if d.label == "person" and d.confidence >= min_confidence]
    if zone:
        people = [p for p in people if point_in_polygon(*foot_point(p.box), zone)]
    gear = [d for d in detections if d.label in GEAR_REGION and d.confidence >= min_confidence * 0.8]
    out = []
    for person in people:
        have = {g.label for g in gear if _gear_on_person(person, g, g.label)}
        missing = [g for g in required if g not in have]
        out.append((person, missing))
    return out


class Cooldown:
    """One alarm per tracked person and violation within the cooldown (so a worker standing at the door
    does not raise a new alarm every frame)."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.last = {}

    def ready(self, key, now):
        t = self.last.get(key)
        if t is not None and now - t < self.seconds:
            return False
        self.last[key] = now
        return True


# ---------- Fire and smoke ----------

SENSITIVITY = {"conservative": 0.75, "balanced": 0.6, "sensitive": 0.45}


class FireSmokeConfirmer:
    """Temporal confirmation. A per-frame detector (and the temporal model's score) must see flame or smoke
    in most frames over `confirm_seconds`, and the region must flicker or grow: steam and dust drift and
    thin out, welding arcs are tiny and static. Confirmation within 1.8 s keeps the alarm under 2 s."""

    def __init__(self, confirm_seconds=1.5, sensitivity="balanced", min_ratio=0.7):
        self.window = confirm_seconds
        self.threshold = SENSITIVITY[sensitivity]
        self.min_ratio = min_ratio
        self.history = []          # (t, label, confidence, area)
        self.fired_at = {}

    def update(self, t, detections):
        """Feed one frame; returns 'fire', 'smoke' or None when an alarm is confirmed now."""
        for d in detections:
            if d.label in ("fire", "smoke"):
                self.history.append((t, d.label, d.confidence, d.box["w"] * d.box["h"]))
        frames = [h for h in self.history if t - h[0] <= self.window]
        self.history = frames
        for label in ("fire", "smoke"):
            hits = [h for h in frames if h[1] == label and h[2] >= self.threshold]
            span = (hits[-1][0] - hits[0][0]) if len(hits) > 1 else 0
            if span < self.window * 0.8:
                continue
            expected = max(1, int(self.window * 10))   # at 10 analysed frames per second
            if len(hits) / expected < self.min_ratio:
                continue
            areas = [h[3] for h in hits]
            growing = areas[-1] > areas[0] * 1.05
            flicker = (max(areas) - min(areas)) / max(max(areas), 1e-9) > 0.1
            tiny_static = max(areas) < 0.0015 and not growing   # welding arc
            if (growing or flicker) and not tiny_static:
                if t - self.fired_at.get(label, -1e9) > 60:      # one alarm per minute per camera
                    self.fired_at[label] = t
                    return label
        return None


# ---------- Restricted areas ----------

def intrusions(detections, zones, classes=("person", "vehicle"), min_confidence=0.5):
    """[(detection, zone)] for people/vehicles whose foot point is inside an exclusion zone and not inside an
    approved machine-motion area. Approved motion (robot arms, conveyors) is ignored by design; returns also
    the count of ignored detections for the platform's statistics."""
    exclusion = [z for z in zones if z["kind"] == "exclusion"]
    allowed = [z for z in zones if z["kind"] == "allowed_motion"]
    hits, ignored = [], 0
    for d in detections:
        if d.confidence < min_confidence:
            continue
        p = foot_point(d.box)
        if any(point_in_polygon(*p, z["points"]) for z in allowed):
            ignored += 1
            continue
        if d.label not in classes:
            ignored += 1 if any(point_in_polygon(*p, z["points"]) for z in exclusion) else 0
            continue
        for z in exclusion:
            if d.label in z.get("classes", classes) and point_in_polygon(*p, z["points"]):
                hits.append((d, z))
                break
    return hits, ignored


class Dwell:
    """Requires an object to stay inside a zone for `seconds` before it counts (filters a hand passing)."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.since = {}

    def update(self, key, inside, t):
        if not inside:
            self.since.pop(key, None)
            return False
        self.since.setdefault(key, t)
        return t - self.since[key] >= self.seconds


# ---------- Quality inspection ----------

def defect_findings(detections, preset_defects, mm_per_pixel, image_width_px, min_defect_mm=0.5, min_confidence=0.5):
    """Defects of the preset's classes at least `min_defect_mm` long. Size: the longer box side in pixels
    times the calibration (mm per pixel). Without calibration every detection counts and size is unknown."""
    out = []
    for d in detections:
        if d.label not in preset_defects or d.confidence < min_confidence:
            continue
        size_mm = None
        if mm_per_pixel:
            size_px = d.attributes.get("size_px") or max(d.box["w"], d.box["h"]) * image_width_px
            size_mm = round(size_px * mm_per_pixel, 2)
            if size_mm < min_defect_mm:
                continue
        out.append((d, size_mm))
    return out


def required_pixel_size(min_defect_mm, pixels_across_defect=3):
    """Camera sizing: the pixel footprint needed to resolve a defect reliably (default 3 px across)."""
    return min_defect_mm / pixels_across_defect


# ---------- Quality grading by surface class (VDA 16) ----------

DEFAULT_ACCEPTANCE = {"A": 0.5, "B": 1.0, "C": 2.0}
_STRICTNESS = {"A": 0, "B": 1, "C": 2}


@dataclass
class Graded:
    detection: Detection
    size_mm: Optional[float]
    surface_class: str
    limit_mm: float
    reject: bool


def surface_class_at(x, y, zones):
    """The surface class at a point: the strictest inspection area containing it. None when inspection areas are
    drawn and the point is outside all of them (background, fixture). Class A when none are drawn."""
    rois = [z for z in zones if z.get("kind") == "inspection_roi"]
    if not rois:
        return "A"
    hits = [z.get("surfaceClass") or "A" for z in rois if point_in_polygon(x, y, z["points"])]
    return min(hits, key=_STRICTNESS.get) if hits else None


def grade_part(detections, preset_defects, zones, acceptance=None, mm_per_pixel=None, image_width_px=1920, min_confidence=0.5):
    """Grades one part. Each defect of the preset's classes is placed in its surface class by its centre and
    rejects the part when it is at least the class limit (mm). Without calibration the size is unknown and every
    defect on the part rejects it: unmeasured defects are never passed. Returns (ok, [Graded ...]), rejects first."""
    acc = {**DEFAULT_ACCEPTANCE, **(acceptance or {})}
    graded = []
    for d in detections:
        if d.label not in preset_defects or d.confidence < min_confidence:
            continue
        cls = surface_class_at(d.box["x"] + d.box["w"] / 2, d.box["y"] + d.box["h"] / 2, zones)
        if cls is None:
            continue
        size_mm = None
        if mm_per_pixel:
            size_px = d.attributes.get("size_px") or max(d.box["w"], d.box["h"]) * image_width_px
            size_mm = round(size_px * mm_per_pixel, 2)
        limit = float(acc[cls])
        graded.append(Graded(d, size_mm, cls, limit, size_mm is None or size_mm >= limit))
    graded.sort(key=lambda g: (not g.reject, _STRICTNESS[g.surface_class], -(g.size_mm or 0)))
    return not any(g.reject for g in graded), graded
