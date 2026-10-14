"""
VATFLOW Tower Cab - placement tool for MSFS 2024 (Windows).

Puts the tower cab "aircraft" at a saved tower position and freezes it there,
so it does not fall, drift or get pushed around by wind.

  python tower_place.py list               show saved towers
  python tower_place.py place KDCA         teleport + freeze at the saved spot
  python tower_place.py adjust KDCA        place, then nudge it with the keyboard and save
  python tower_place.py capture KDCA       save wherever the cab is right now (e.g. after slewing)
  python tower_place.py release            unfreeze (to slew or move it yourself)

Needs:  pip install SimConnect      (the Python-SimConnect package, which bundles SimConnect.dll)
Start MSFS, load a flight at the airport with the tower cab selected, then run this.
"""

import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TOWERS_FILE = os.path.join(HERE, "towers.json")
M_PER_DEG_LAT = 111320.0
FT_PER_M = 3.28084

FREEZE_EVENTS = (b"FREEZE_LATITUDE_LONGITUDE_SET", b"FREEZE_ALTITUDE_SET", b"FREEZE_ATTITUDE_SET")


# ---------------------------------------------------------------------------
# Pure helpers (no simulator needed)
# ---------------------------------------------------------------------------

def load_towers(path=TOWERS_FILE):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_towers(towers, path=TOWERS_FILE):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(towers, f, indent=2)
        f.write("\n")


def move(pos, fwd_m=0.0, right_m=0.0, up_ft=0.0, turn_deg=0.0):
    """Return a new position moved relative to its own heading (flat earth, fine for meters)."""
    hdg = math.radians(pos["headingTrue"])
    north = fwd_m * math.cos(hdg) - right_m * math.sin(hdg)
    east = fwd_m * math.sin(hdg) + right_m * math.cos(hdg)
    lat = pos["lat"] + north / M_PER_DEG_LAT
    lon = pos["lon"] + east / (M_PER_DEG_LAT * math.cos(math.radians(pos["lat"])))
    out = dict(pos)
    out.update({
        "lat": round(lat, 8),
        "lon": round(lon, 8),
        "cabFloorFtMsl": round(pos["cabFloorFtMsl"] + up_ft, 1),
        "headingTrue": round((pos["headingTrue"] + turn_deg) % 360, 1),
    })
    return out


ADJUST_HELP = """
  u N / d N   up / down N feet          f N / b N   forward / back N meters
  r N / l N   right / left N meters     t N         turn N degrees (negative = left)
  h N         set heading to N (true)   save        save to towers.json
  q           quit (stays frozen where it is)
"""


def parse_adjust(cmd):
    """'u 2' -> dict of move() kwargs, or None if not a move command."""
    parts = cmd.split()
    if len(parts) != 2:
        return None
    key, val = parts[0].lower(), parts[1]
    try:
        n = float(val)
    except ValueError:
        return None
    return {
        "u": {"up_ft": n}, "d": {"up_ft": -n},
        "f": {"fwd_m": n}, "b": {"fwd_m": -n},
        "r": {"right_m": n}, "l": {"right_m": -n},
        "t": {"turn_deg": n},
    }.get(key)


# ---------------------------------------------------------------------------
# Simulator side
# ---------------------------------------------------------------------------

class Sim:
    def __init__(self):
        try:
            from SimConnect import Event, Request, SimConnect
        except ImportError:
            sys.exit("Python-SimConnect is not installed: run  pip install SimConnect")
        self._Event, self._Request = Event, Request
        try:
            self.sm = SimConnect()
        except Exception as e:  # the library raises a bare ConnectionError-ish exception
            sys.exit("Could not connect to MSFS (is a flight loaded?): %s" % e)

    def freeze(self, on):
        for name in FREEZE_EVENTS:
            self._Event(name, self.sm)(1 if on else 0)

    def place(self, pos):
        self.freeze(False)
        time.sleep(0.2)
        self.sm.set_pos(
            _Altitude=pos["cabFloorFtMsl"],
            _Latitude=pos["lat"],
            _Longitude=pos["lon"],
            _Airspeed=0,
            _Pitch=0.0,
            _Bank=0.0,
            _Heading=pos["headingTrue"],
            _OnGround=0,
        )
        time.sleep(0.5)
        self.freeze(True)

    def read(self, simvar, unit):
        req = self._Request((simvar, unit), self.sm, _time=0)
        for _ in range(30):
            v = req.value
            if v is not None:
                return v
            time.sleep(0.1)
        raise RuntimeError("no answer from the sim for %s" % simvar.decode())

    def position(self):
        return {
            "lat": round(self.read(b"PLANE LATITUDE", b"degrees"), 8),
            "lon": round(self.read(b"PLANE LONGITUDE", b"degrees"), 8),
            "cabFloorFtMsl": round(self.read(b"PLANE ALTITUDE", b"feet"), 1),
            "headingTrue": round(self.read(b"PLANE HEADING DEGREES TRUE", b"degrees") % 360, 1),
        }

    def close(self):
        self.sm.exit()


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def get_tower(towers, icao):
    t = towers.get(icao.upper())
    if not t:
        sys.exit("No saved tower %s. Saved: %s (use 'capture %s' to add one)" % (icao, ", ".join(sorted(towers)), icao.upper()))
    return t


def describe(icao, t):
    return "%s  %.6f, %.6f  floor %.0f ft MSL  heading %.0f T" % (icao, t["lat"], t["lon"], t["cabFloorFtMsl"], t["headingTrue"])


def cmd_list(towers):
    for icao in sorted(towers):
        print(describe(icao, towers[icao]))
        if towers[icao].get("note"):
            print("      " + towers[icao]["note"])


def cmd_place(towers, icao):
    t = get_tower(towers, icao)
    sim = Sim()
    sim.place(t)
    print("Placed and frozen: " + describe(icao.upper(), t))
    sim.close()


def cmd_adjust(towers, icao):
    icao = icao.upper()
    pos = dict(get_tower(towers, icao))
    sim = Sim()
    sim.place(pos)
    print("Placed: " + describe(icao, pos))
    print(ADJUST_HELP)
    while True:
        try:
            cmd = input("adjust> ").strip()
        except EOFError:
            break
        if cmd in ("q", "quit", "exit"):
            break
        if cmd == "save":
            towers[icao] = pos
            save_towers(towers)
            print("Saved " + describe(icao, pos))
            continue
        if cmd.startswith("h "):
            try:
                pos = move(pos, turn_deg=float(cmd.split()[1]) - pos["headingTrue"])
            except ValueError:
                print(ADJUST_HELP)
                continue
        else:
            kwargs = parse_adjust(cmd)
            if kwargs is None:
                print(ADJUST_HELP)
                continue
            pos = move(pos, **kwargs)
        sim.place(pos)
        print("  " + describe(icao, pos))
    sim.close()


def cmd_capture(towers, icao):
    icao = icao.upper()
    sim = Sim()
    pos = sim.position()
    sim.freeze(True)
    sim.close()
    old = towers.get(icao, {})
    pos["name"] = old.get("name", icao)
    pos["note"] = "captured in sim " + time.strftime("%Y-%m-%d")
    towers[icao] = pos
    save_towers(towers)
    print("Captured and frozen: " + describe(icao, pos))


def cmd_release():
    sim = Sim()
    sim.freeze(False)
    sim.close()
    print("Unfrozen.")


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        return
    towers = load_towers()
    cmd = argv[1].lower()
    if cmd == "list":
        cmd_list(towers)
    elif cmd == "release":
        cmd_release()
    elif cmd in ("place", "adjust", "capture") and len(argv) >= 3:
        {"place": cmd_place, "adjust": cmd_adjust, "capture": cmd_capture}[cmd](towers, argv[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
