"""
Generates the tower cab interior textures (procedural, no source images needed):

  python make_textures.py <texture_dir>

Writes, for each texture, NAME.png plus the NAME.png.xml MSFS compiles it with
(slot = base colour). The interior exporter maps them by world position, so the
"meters" below is how much floor/ceiling/console one copy of the texture covers.

  TWR_Carpet_albd.png   2.4 m  - quarter-turned 60 cm commercial carpet tiles
  TWR_Ceiling_albd.png  1.2 m  - 60 cm charcoal acoustic ceiling tiles in a light grey T-bar grid
  TWR_Console_albd.png  1.0 m  - dark grey matte laminate
  TWR_ConsoleTop_albd.png    1.0 m  - console worktop: medium blue laminate (colours from a cab photo)
  TWR_ConsoleFront_albd.png  1.0 m  - console fronts: blue perforated steel vent panels, 50 cm wide (+ _norm)

Surface detail (roughness / normal), same size and layout as the base colour:
  TWR_Carpet_comp.png / _norm.png    - fibre and tile seams; seams darker (occlusion)
  comp = occlusion (R) / roughness (G) / metallic (B); norm = DirectX normal map

  TWR_Wood_albd.png     1.0 m  - light oak (TMU desk edging and panels)

Decals, stretched once over the top of a desk item:
  TWR_Keypad_albd.png    - keypad with orange / green / teal / yellow keys
  TWR_Keyboard_albd.png  - black keyboard
  TWR_Speaker_albd.png   - perforated speaker grille
  TWR_GuideSheet_albd.png - the quick guide (moving the cab) laminated on the TMU desk
  TWR_FanLabel_albd.png   - the FAN label above the ceiling fan switch
  TWR_FwdSign_albd.png    - the FWD placard on the front console (which way FWD moves the cab)
  TWR_Banner_albd.png     - the party banner's cards ("GOOD LUCK AT ZDC LIVE, WE'RE ALL COUNTING
                            ON YOU"), BANNER_COLS x BANNER_ROWS cards, one word each
  TWR_CarpetLogo_albd.png 2.4 m  - the carpet with "MADE AND POWERED BY VATFLOW TECHNOLOGIES"
                          woven in (the floor patch at the back of the cab; carpet_logo)
"""

import os
import sys

import numpy as np
from PIL import Image

RNG = np.random.default_rng(1997)   # DCA tower year: fixed seed, same output every run

TEXTURES = {
    # name: meters covered by one copy of the texture
    "TWR_Carpet_albd.png": 2.4,
    "TWR_Ceiling_albd.png": 1.2,
    "TWR_Console_albd.png": 1.0,
    "TWR_Keypad_albd.png": None,
    "TWR_Keyboard_albd.png": None,
    "TWR_Speaker_albd.png": None,
    "TWR_Wood_albd.png": 1.0,
    "TWR_ConsoleTop_albd.png": 1.0,
    "TWR_ConsoleFront_albd.png": 1.0,
    "TWR_ConsoleFront_norm.png": 1.0,
    "TWR_Carpet_comp.png": 2.4,
    "TWR_Carpet_norm.png": 2.4,
}

# Base colour: same as the SDK SimpleAircraft sample's SimpleAircraft_COCKPIT_albd.png.xml.
# The comp and normal slots are the SDK's names for those texture kinds.
XML = "<BitmapConfiguration><BitmapSlot>MTL_BITMAP_DECAL0</BitmapSlot></BitmapConfiguration>"
XML_SLOTS = {
    "_albd": XML,
    "_comp": "<BitmapConfiguration><BitmapSlot>MTL_BITMAP_METAL_ROUGH_AO</BitmapSlot></BitmapConfiguration>",
    "_norm": "<BitmapConfiguration><BitmapSlot>MTL_BITMAP_NORMAL</BitmapSlot></BitmapConfiguration>",
}


def hexrgb(h):
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)


def blur(a, r):
    """Cheap separable box blur that wraps (keeps textures tileable)."""
    out = a.copy()
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for d in range(-r, r + 1):
            acc += np.roll(out, d, axis=axis)
        out = acc / (2 * r + 1)
    return out


def tile_noise(size, scale, octaves=3):
    """Tileable value noise in 0..1."""
    total = np.zeros((size, size), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        cells = max(2, int(scale * (2 ** o)))
        grid = RNG.random((cells, cells)).astype(np.float32)
        # resize a 3 x 3 tiling of the grid and keep the middle: seamless at the edges
        big = Image.fromarray((np.tile(grid, (3, 3)) * 255).astype(np.uint8)).resize((3 * size, 3 * size), Image.BICUBIC)
        layer = np.asarray(big, np.float32)[size:2 * size, size:2 * size] / 255.0
        layer = blur(layer, 2)
        total += layer * amp
        norm += amp
        amp *= 0.5
    return total / norm


def save(img, out_dir, name):
    mode = "RGBA" if img.shape[2] == 4 else "RGB"
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), mode).save(os.path.join(out_dir, name), optimize=True)
    kind = os.path.splitext(name)[0][-5:]                 # _albd / _comp / _norm
    with open(os.path.join(out_dir, name + ".xml"), "w", encoding="utf-8") as f:
        f.write(XML_SLOTS[kind])


def normal_map(height, strength):
    """Height field (0..1, tileable) -> DirectX tangent-space normal map (RGB 0..255)."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    n = np.dstack([-dx, dy, np.ones_like(height)])          # DirectX: green points down the image
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return (n * 0.5 + 0.5) * 255


def comp(ao, rough, metal=0.0):
    """Occlusion / roughness / metallic (0..1 each) -> comp texture (R, G, B)."""
    return np.dstack([ao, rough, np.full_like(ao, metal)]) * 255


def carpet(size=1024):
    base = hexrgb("2C3747")                           # charcoal grey-blue (from a cab photo)
    img = np.tile(base, (size, size, 1))
    t = size // 4                                     # 4 x 4 tiles of 60 cm
    y, x = np.mgrid[0:size, 0:size]
    # quarter-turned tiles: fine directional ribs alternating per tile
    tile_parity = ((x // t) + (y // t)) % 2
    ribs = np.where(tile_parity == 0, np.sin(x * 0.9), np.sin(y * 0.9)) * 3.0
    # per-tile slight tone shift
    tone = RNG.normal(0, 2.5, (4, 4))[(y // t) % 4, (x // t) % 4]
    fleck = (RNG.random((size, size)) - 0.5) * 22 * (RNG.random((size, size)) > 0.6)
    mottle = (tile_noise(size, 8) - 0.5) * 14
    v = ribs + tone + fleck + mottle
    img = img + v[..., None] * np.array([0.9, 0.95, 1.1])
    # tile seams: barely darker lines
    seam = ((x % t) < 2) | ((y % t) < 2)
    img[seam] *= 0.85
    return img


def ceiling(size=1024):
    # a real cab ceiling: charcoal acoustic tiles in a light grey T-bar grid (dark, so the
    # glass doesn't mirror it at night)
    base = hexrgb("2A2D35")
    img = np.tile(base, (size, size, 1))
    y, x = np.mgrid[0:size, 0:size]
    pits = blur((RNG.random((size, size)) > 0.97).astype(np.float32), 1) * 30          # fissures
    speck = (RNG.random((size, size)) - 0.5) * 8
    mottle = (tile_noise(size, 6) - 0.5) * 8
    img = img - pits[..., None] + (speck + mottle)[..., None]
    # T-bar grid every 60 cm (512 px): light grey painted metal, a darker shadow line beside it
    g = size // 2
    bar = ((x % g) < 7) | ((y % g) < 7)
    shadow = (((x % g) >= 7) & ((x % g) < 10)) | (((y % g) >= 7) & ((y % g) < 10))
    img[shadow & ~bar] *= 0.6
    img[bar] = hexrgb("8A8E93")
    return img


def console(size=512):
    base = hexrgb("2A2C30")
    img = np.tile(base, (size, size, 1))
    grain = blur((RNG.random((size, size)) - 0.5).astype(np.float32), 1) * 10
    streaks = blur((RNG.random((size, 1)) - 0.5).astype(np.float32).repeat(size, 1), 0) * 3
    mottle = (tile_noise(size, 4) - 0.5) * 6
    return img + (grain + streaks + mottle)[..., None]


def console_top(size=1024):
    # medium blue high-pressure laminate (photo: #4E7CB4), fine speckle and soft wear
    base = hexrgb("4A76AE")
    img = np.tile(base, (size, size, 1))
    speck = blur((RNG.random((size, size)) - 0.5).astype(np.float32), 1) * 14
    mottle = (tile_noise(size, 5) - 0.5) * 10
    return img + (speck + mottle)[..., None] * np.array([0.8, 0.9, 1.0])


def console_front(size=1024):
    """
    Console fronts: blue powder-coated steel vent panels for the computers inside (photo:
    #347FC0 in light .. #274172 in shade). One copy = 1 m: two 50 cm panels side by side,
    each with a solid 3.5 cm frame and a perforated field (6 mm holes on a 12 mm grid, dark
    behind). The UVs put texture V = height above the floor, so the frame's top and bottom
    bars sit at the console front's edges (10 cm and 82.5 cm up). Returns colour and height.
    """
    y, x = np.mgrid[0:size, 0:size]
    z = 1.0 - (y + 0.5) / size                      # metres above the floor (image top = 1 m)
    u = (x + 0.5) / size                            # metres along
    blue = hexrgb("3270B4")
    img = np.tile(blue, (size, size, 1)).astype(np.float32)
    img += ((tile_noise(size, 5) - 0.5) * 8)[..., None]           # powder-coat orange peel
    fw = 0.035
    in_frame = ((u % 0.5) < fw) | ((u % 0.5) > 0.5 - fw) | (z < 0.10 + fw) | (z > 0.825 - fw)
    # perforations: holes on a 12 mm grid, staggered rows
    pitch = 0.012
    row = np.floor(z / pitch)
    hu = (u + (row % 2) * pitch / 2) % pitch - pitch / 2
    hz = z % pitch - pitch / 2
    hole = (hu * hu + hz * hz) < (0.0032 ** 2)
    field = ~in_frame
    img[field & hole] = hexrgb("0E1A2C")                           # dark behind the holes
    img[field & ~hole] *= 0.93                                    # the perforated sheet a bit darker
    # panel seams between frames, and a soft shadow line inside each frame
    seam = ((u % 0.5) < 0.003) | ((u % 0.5) > 0.497)
    img[seam] *= 0.45
    inner = (((u % 0.5) >= fw) & ((u % 0.5) < fw + 0.004)) | ((z >= 0.10 + fw) & (z < 0.10 + fw + 0.004))
    img[inner & field] *= 0.7
    height = np.ones((size, size), np.float32)
    height[field] = 0.85                                          # field set back from the frame
    height[field & hole] = 0.2
    height[seam] = 0.3
    return img, blur(height, 1)


def keys(img, x0, y0, cols, rows, kw, kh, gap, colors, legend=(200, 200, 200)):
    """Draws a grid of key caps (with a lighter top edge and a small legend mark)."""
    for r in range(rows):
        for c in range(cols):
            col = hexrgb(colors[(r * cols + c) % len(colors)] if isinstance(colors, list) else colors(r, c))
            x, y = x0 + c * (kw + gap), y0 + r * (kh + gap)
            img[y:y + kh, x:x + kw] = col
            img[y:y + 3, x:x + kw] = np.minimum(col * 1.35 + 20, 255)
            img[y + kh - 3:y + kh, x:x + kw] = col * 0.6
            lx, ly = x + kw // 4, y + kh // 3
            img[ly:ly + 4, lx:lx + kw // 3] = legend
    return img


def keypad(w=512, h=256):
    img = np.tile(hexrgb("1E1F21"), (h, w, 1))
    pal = ["F08A3C", "F08A3C", "3CB371", "F08A3C", "2BB3B3", "F0C83C", "F08A3C", "3CB371"]
    return keys(img, 16, 14, 12, 6, 34, 32, 6, pal, legend=(40, 30, 20))


def keyboard(w=1024, h=256):
    img = np.tile(hexrgb("101012"), (h, w, 1))
    img = keys(img, 14, 10, 15, 1, 54, 34, 10, ["2A2A2E"])                    # function row
    img = keys(img, 14, 54, 15, 3, 54, 40, 8, ["232326", "232326", "232326", "2E2E33"])
    img = keys(img, 14, 198, 3, 1, 54, 44, 10, ["2E2E33"])
    img[198:242, 206:742] = hexrgb("232326")                                  # space bar
    img = keys(img, 750, 198, 4, 1, 54, 44, 10, ["2E2E33"])
    return img


def speaker(size=256):
    img = np.tile(hexrgb("4A463E"), (size, size, 1))
    y, x = np.mgrid[0:size, 0:size]
    holes = (((x % 10) - 5) ** 2 + ((y % 10) - 5) ** 2) < 7
    img[holes] = hexrgb("0E0E0E")
    img[:8], img[-8:], img[:, :8], img[:, -8:] = (hexrgb("6E6350"),) * 4
    return img


# the woven-in logo on the carpet at the back of the cab (blender/build_tower_cab.py
# carpet_logo() lays a patch of floor there with this texture; same numbers in both)
LOGO_CENTER = (0.0, 1.75)      # meters, cab coordinates (+Y = the back, the stairs)
LOGO_SIZE = (2.0, 0.85)
CARPET_M = 2.4                 # one copy of the carpet texture covers 2.4 m (exporter TEXTURED)


def carpet_logo(carpet_img):
    """
    "MADE AND POWERED BY / VATFLOW TECHNOLOGIES" dyed into the carpet: the same carpet
    texture (so the patch matches the floor round it exactly), with the lettering and a thin
    inlay border in lighter yarn. The letters keep the carpet's ribs, flecks and seams (the
    carpet is recoloured, not covered) and a darker stitch line runs round them. Placed in
    the texture where the floor's world-space mapping puts LOGO_CENTER, wrapping like the
    carpet does. Reads from the cab's middle looking back.
    """
    from PIL import ImageDraw, ImageFilter
    size = carpet_img.shape[0]
    ppm = size / CARPET_M
    W, H = int(round(LOGO_SIZE[0] * ppm)), int(round(LOGO_SIZE[1] * ppm))
    k = 4                                                  # draw big, scale down: smooth edges
    m = Image.new("L", (W * k, H * k), 0)
    d = ImageDraw.Draw(m)
    px = ppm * k
    b, t = int(0.035 * px), max(2, int(0.012 * px))
    d.rectangle([b, b, W * k - b, H * k - b], outline=255, width=t)
    for text, cap, yc in (("MADE AND POWERED BY", 0.065, 0.28), ("VATFLOW TECHNOLOGIES", 0.17, 0.60)):
        f = font(int(cap * px / 0.72), True)
        tw = d.textlength(text, font=f)
        if tw > 0.86 * W * k:                              # fit the width inside the border
            cap *= 0.86 * W * k / tw
            f = font(int(cap * px / 0.72), True)
            tw = d.textlength(text, font=f)
        top = f.getbbox(text)[1]
        d.text(((W * k - tw) / 2, yc * H * k - (cap * px) / 2 - top), text, font=f, fill=255)
    mask = np.array(m.resize((W, H), Image.LANCZOS)).astype(np.float32) / 255.0
    halo = np.array(m.filter(ImageFilter.MaxFilter(9)).resize((W, H), Image.LANCZOS)).astype(np.float32) / 255.0
    # where the patch's top-left corner falls in the repeating texture (glTF V runs down)
    x0, ytop = LOGO_CENTER[0] - LOGO_SIZE[0] / 2, LOGO_CENTER[1] + LOGO_SIZE[1] / 2
    col0 = int(round((x0 / CARPET_M) % 1.0 * size))
    row0 = int(round((1.0 - (ytop / CARPET_M) % 1.0) % 1.0 * size))
    full, fhalo = np.zeros((size, size), np.float32), np.zeros((size, size), np.float32)
    full[:H, :W], fhalo[:H, :W] = mask, halo
    full = np.roll(np.roll(full, row0, axis=0), col0, axis=1)
    fhalo = np.roll(np.roll(fhalo, row0, axis=0), col0, axis=1)
    img = carpet_img.copy()
    base = hexrgb("2C3747")
    yarn = hexrgb("9DAAC0")                                # light steel-blue yarn
    dyed = img * (yarn / base)                             # the carpet's own texture, lighter
    stitch = np.clip(fhalo - full, 0, 1)[..., None] * 0.22  # darker line round the letters
    img = img * (1 - stitch)
    img = img + full[..., None] * (dyed - img)
    return img


def carpet_detail(size=1024):
    """comp + normal for the carpet: fibre noise, alternating rib direction, sunken tile seams."""
    t = size // 4
    y, x = np.mgrid[0:size, 0:size]
    parity = ((x // t) + (y // t)) % 2
    ribs = np.where(parity == 0, np.sin(x * 0.9), np.sin(y * 0.9)) * 0.5 + 0.5
    fibre = blur(RNG.random((size, size)).astype(np.float32), 1)
    seam = (((x % t) < 3) | ((y % t) < 3)).astype(np.float32)
    seam = blur(seam, 2)
    height = 0.35 * ribs + 0.5 * fibre - 0.9 * seam
    ao = 1.0 - 0.35 * seam
    rough = np.clip(0.9 + 0.08 * fibre, 0, 1)
    return comp(ao, rough), normal_map(height, 6.0)


def wood(size=512):
    """Light oak: long straight grain with a little waviness, tileable."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    wave = (tile_noise(size, 3) - 0.5) * 12
    grain = np.sin((y + wave) * 2 * np.pi / size * 40) * 0.5 + 0.5
    fine = blur(RNG.random((size, size)).astype(np.float32), 1)
    v = 0.5 * grain ** 4 + 0.5 * fine
    base, dark = hexrgb("B48E68"), hexrgb("9C7A56")
    return base[None, None, :] * (1 - v[..., None] * 0.35) + dark[None, None, :] * (v[..., None] * 0.35)


GUIDE = [
    ("h1", "TOWER CAB - QUICK GUIDE"),
    ("h2", "PUT THE CAB IN THE TOWER"),
    ("p", "1  On any big screen tap MENU (bottom right), then TOWER SETUP."),
    ("p", "2  PLACE IN TOWER: the cab goes to this airport's saved spot, else the FAA's control "
          "tower position (US) or OpenStreetMap's tower, and freezes there."),
    ("h2", "MOVE IT ONTO THE REAL TOWER"),
    ("p", "3  Pick a step: FINE 0.5 m, MEDIUM 2 m or BIG 10 m."),
    ("p", "4  FWD / BACK / LEFT / RIGHT move it as seen out of the FRONT window. UP / DOWN change the "
          "height, TURN L / TURN R turn the cab."),
    ("p", "5  SAVE THIS SPOT. Next time at this airport the cab goes straight there."),
    ("h2", "GOOD TO KNOW"),
    ("p", "- AUTO PLACE ON SPAWN: the cab goes up by itself about 10 s after the flight starts."),
    ("p", "- RELEASE unfreezes the cab (slew); PLACE IN TOWER freezes it again."),
    ("p", "- FORGET SAVED SPOT goes back to the FAA / OpenStreetMap spot."),
    ("p", "- Keep crash damage OFF (Assistance), or touching the tower ends the flight."),
    ("p", "- \"NOT IN THE TOWER\" on a screen: tap it for TOWER SETUP."),
    ("p", "- Brightness: TOWER SETUP > BRIGHTNESS, or the knobs on the console. "
          "Up to 200 % for bright days. Ceiling fans: the FAN switch on this desk's far end."),
]


def font(size, bold=False):
    """A TrueType font (DejaVu / Liberation), else Pillow's own."""
    from PIL import ImageFont
    for f in (("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"), ("LiberationSans-Bold.ttf" if bold else "LiberationSans-Regular.ttf")):
        for base in ("/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/truetype/liberation", "C:/Windows/Fonts"):
            try:
                return ImageFont.truetype(os.path.join(base, f), size)
            except OSError:
                pass
    return ImageFont.load_default()


def fan_label(w=256, h=128):
    """The engraved label above the ceiling fan switch: white FAN on a black plate."""
    from PIL import ImageDraw
    img = Image.new("RGB", (w, h), (18, 18, 20))
    d = ImageDraw.Draw(img)
    d.rectangle([5, 5, w - 6, h - 6], outline=(150, 150, 155), width=3)
    f = font(78, True)
    tw = d.textlength("FAN", font=f)
    d.text(((w - tw) / 2, (h - 78) / 2 - 8), "FAN", font=f, fill=(240, 240, 240))
    return np.array(img).astype(np.float32)


def fwd_sign(w=1024, h=512):
    """
    The FWD placard low on the front console: a big arrow pointing up (towards the front
    window, which is FWD on TOWER SETUP's MOVE THE CAB pad) with FWD beside it.
    """
    from PIL import ImageDraw
    img = Image.new("RGB", (w, h), (20, 30, 44))
    d = ImageDraw.Draw(img)
    d.rectangle([10, 10, w - 11, h - 11], outline=(255, 196, 40), width=10)
    cx, top, bot = 230, 60, 450                       # arrow, pointing up
    d.polygon([(cx, top), (cx + 150, top + 160), (cx + 55, top + 160), (cx + 55, bot),
               (cx - 55, bot), (cx - 55, top + 160), (cx - 150, top + 160)], fill=(255, 196, 40))
    f = font(200, True)
    d.text((420, 70), "FWD", font=f, fill=(255, 255, 255))
    s = font(38, True)
    d.text((424, 320), "FRONT OF THE CAB", font=s, fill=(255, 196, 40))
    d.text((424, 372), "TOWER SETUP > MOVE", font=font(34), fill=(200, 210, 220))
    return np.array(img).astype(np.float32)


# the party banner on the back-right console: one word per card (blender/build_tower_cab.py
# party_banner() hangs BANNER_WORDS cards and maps card i to slot i of this texture)
BANNER_WORDS = ["GOOD", "LUCK", "AT", "ZDC", "LIVE,", "WE'RE", "ALL", "COUNTING", "ON", "YOU"]
BANNER_COLS, BANNER_ROWS = 5, 2
BANNER_COLOURS = [("D62828", "FFFFFF"), ("F7B32B", "1A1A1A"), ("1F7AE0", "FFFFFF"), ("2BA84A", "FFFFFF"),
                  ("8E44AD", "FFFFFF"), ("F06292", "FFFFFF")]


def banner(w=2048, h=1024):
    """
    The party banner's cards, BANNER_COLS x BANNER_ROWS, in party colours with a thin white
    edge, a row of dots along the top and the word in big bold letters (smaller for long words).
    """
    from PIL import ImageDraw
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    for i, word in enumerate(BANNER_WORDS):
        x0, y0 = round((i % BANNER_COLS) * w / BANNER_COLS), round((i // BANNER_COLS) * h / BANNER_ROWS)
        x1, y1 = round((i % BANNER_COLS + 1) * w / BANNER_COLS), round((i // BANNER_COLS + 1) * h / BANNER_ROWS)
        bg, fg = BANNER_COLOURS[i % len(BANNER_COLOURS)]
        d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=tuple(int(c) for c in hexrgb(bg)))
        d.rectangle([x0 + 10, y0 + 10, x1 - 11, y1 - 11], outline=(255, 255, 255), width=6)
        for k in range(6):                                  # dots along the top, under the string
            cx = x0 + (k + 0.5) * (x1 - x0) / 6
            d.ellipse([cx - 9, y0 + 34, cx + 9, y0 + 52], fill=(255, 255, 255))
        cw = x1 - x0 - 50
        size = 170
        f = font(size, True)
        while d.textlength(word, font=f) > cw and size > 40:
            size -= 6
            f = font(size, True)
        tw = d.textlength(word, font=f)
        bb = f.getbbox(word)
        d.text((x0 + (x1 - x0 - tw) / 2, y0 + (y1 - y0) * 0.45 - (bb[1] + bb[3]) / 2), word, font=f,
               fill=tuple(int(c) for c in hexrgb(fg)))
    return np.array(img).astype(np.float32)


def guide_sheet(w=792, h=1024):
    """
    The quick guide lying on the TMU desk under clear laminate: a printed US letter sheet
    (8.5 x 11 in). Drawn at the sheet's shape, then stored square (1024 x 1024); the desk
    quad's UVs stretch it back. Needs a TrueType font (DejaVu / Liberation); falls back to
    Pillow's own.
    """
    from PIL import ImageDraw
    img = Image.new("RGB", (w, h), (246, 245, 240))
    d = ImageDraw.Draw(img)
    fonts = {"h1": font(36, True), "h2": font(24, True), "p": font(21)}
    margin, y = 54, 52
    d.rectangle([margin - 18, 30, w - margin + 18, 34], fill=(32, 78, 140))
    for kind, text in GUIDE:
        f = fonts[kind]
        if kind == "h2":
            y += 14
        words, line = text.split(" "), ""
        indent = 0 if kind != "p" or not text[:1].isdigit() and not text.startswith("-") else 34
        first = True
        for word in words + [None]:
            trial = (line + " " + word).strip() if word else line
            x0 = margin + (0 if first else indent)
            if word is not None and d.textlength(trial, font=f) <= w - margin - x0:
                line = trial
                continue
            d.text((x0, y), line, font=f, fill=(32, 78, 140) if kind != "p" else (25, 25, 28))
            y += int(f.size * 1.28)
            first, line = False, word or ""
        y += 8 if kind == "p" else 4
        if kind == "h1":
            y += 6
    assert y < h - 60, "the quick guide text is too long for the sheet"
    d.text((margin, h - 48), "VATFLOW Tower Cab", font=font(18), fill=(120, 120, 125))
    img = img.resize((1024, 1024), Image.LANCZOS)
    return np.array(img).astype(np.float32)


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    cp = carpet()
    save(cp, out_dir, "TWR_Carpet_albd.png")
    save(carpet_logo(cp), out_dir, "TWR_CarpetLogo_albd.png")
    save(ceiling(), out_dir, "TWR_Ceiling_albd.png")
    save(console(), out_dir, "TWR_Console_albd.png")
    save(console_top(), out_dir, "TWR_ConsoleTop_albd.png")
    cf, ch = console_front()
    save(cf, out_dir, "TWR_ConsoleFront_albd.png")
    save(normal_map(ch, 2.0), out_dir, "TWR_ConsoleFront_norm.png")
    save(keypad(), out_dir, "TWR_Keypad_albd.png")
    save(keyboard(), out_dir, "TWR_Keyboard_albd.png")
    save(speaker(), out_dir, "TWR_Speaker_albd.png")
    save(guide_sheet(), out_dir, "TWR_GuideSheet_albd.png")
    save(fan_label(), out_dir, "TWR_FanLabel_albd.png")
    save(fwd_sign(), out_dir, "TWR_FwdSign_albd.png")
    save(banner(), out_dir, "TWR_Banner_albd.png")
    save(wood(), out_dir, "TWR_Wood_albd.png")
    c, nrm = carpet_detail()
    save(c, out_dir, "TWR_Carpet_comp.png")
    save(nrm, out_dir, "TWR_Carpet_norm.png")
    print("Wrote", ", ".join(sorted(TEXTURES)), "to", out_dir)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
