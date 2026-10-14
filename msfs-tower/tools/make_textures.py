"""
Generates the tower cab interior textures (procedural, no source images needed):

  python make_textures.py <texture_dir>

Writes, for each texture, NAME.png plus the NAME.png.xml MSFS compiles it with
(slot = base colour). The interior exporter maps them by world position, so the
"meters" below is how much floor/ceiling/console one copy of the texture covers.

  TWR_Carpet_albd.png   2.4 m  - quarter-turned 60 cm commercial carpet tiles
  TWR_Ceiling_albd.png  1.2 m  - 60 cm black acoustic ceiling tiles in a black T-bar grid
  TWR_Console_albd.png  1.0 m  - dark grey matte laminate

Surface detail (roughness / normal), same size and layout as the base colour:
  TWR_Carpet_comp.png / _norm.png    - fibre and tile seams; seams darker (occlusion)
  TWR_Console_comp.png / _norm.png   - shiny finger smudges, dull scuffs, fine scratches
  comp = occlusion (R) / roughness (G) / metallic (B); norm = DirectX normal map

Wear layers (base colour with alpha, laid over other surfaces):
  TWR_FloorWear_albd.png    3.6 m  - traffic wear: matted dark paths, fuzzed light patches
  TWR_GlassSmudge_albd.png  1 pane - grime along the bottom, finger smudges, cleaning
                                     streaks and dust on the inside of each window

Decals, stretched once over the top of a desk item:
  TWR_Keypad_albd.png    - keypad with orange / green / teal / yellow keys
  TWR_Keyboard_albd.png  - black keyboard
  TWR_Speaker_albd.png   - perforated speaker grille
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
    "TWR_Carpet_comp.png": 2.4,
    "TWR_Carpet_norm.png": 2.4,
    "TWR_Console_comp.png": 1.0,
    "TWR_Console_norm.png": 1.0,
    "TWR_FloorWear_albd.png": 3.6,
    "TWR_GlassSmudge_albd.png": None,
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


def blobs(size, count, rmin, rmax, aspect=1.0, wrap=True, rng=None):
    """Soft elliptical spots (0..1), wrapping round the edges so the texture still tiles."""
    rng = rng or RNG
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    out = np.zeros((size, size), np.float32)
    for _ in range(count):
        cx, cy = rng.random() * size, rng.random() * size
        r = rmin + rng.random() * (rmax - rmin)
        a = rng.random() * np.pi
        ddx, ddy = x - cx, y - cy
        if wrap:
            ddx = (ddx + size / 2) % size - size / 2
            ddy = (ddy + size / 2) % size - size / 2
        u = (ddx * np.cos(a) + ddy * np.sin(a)) / r
        v = (-ddx * np.sin(a) + ddy * np.cos(a)) / (r * aspect)
        out = np.maximum(out, np.clip(1 - (u * u + v * v), 0, 1) ** 1.5 * (0.5 + 0.5 * rng.random()))
    return out


def carpet(size=1024):
    base = hexrgb("2E3847")
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
    # the DCA cab ceiling is black (no reflections in the glass at night)
    base = hexrgb("1C1C1E")
    img = np.tile(base, (size, size, 1))
    y, x = np.mgrid[0:size, 0:size]
    pits = blur((RNG.random((size, size)) > 0.985).astype(np.float32), 1) * 40
    mottle = (tile_noise(size, 6) - 0.5) * 6
    img = img - pits[..., None] + mottle[..., None]
    # T-bar grid every 60 cm (512 px): flat black metal with a faint lit edge
    g = size // 2
    bar = ((x % g) < 6) | ((y % g) < 6)
    edge = (((x % g) >= 6) & ((x % g) < 8)) | (((y % g) >= 6) & ((y % g) < 8))
    img[bar] = hexrgb("0C0C0D")
    img[edge & ~bar] = hexrgb("2A2A2D")
    return img


def console(size=512):
    base = hexrgb("2A2C30")
    img = np.tile(base, (size, size, 1))
    grain = blur((RNG.random((size, size)) - 0.5).astype(np.float32), 1) * 10
    streaks = blur((RNG.random((size, 1)) - 0.5).astype(np.float32).repeat(size, 1), 0) * 3
    mottle = (tile_noise(size, 4) - 0.5) * 6
    return img + (grain + streaks + mottle)[..., None]


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


def console_detail(size=512):
    """comp + normal for the console laminate: shiny finger smudges, dull scuffs, scratches."""
    rough = np.full((size, size), 0.62, np.float32) + (tile_noise(size, 5) - 0.5) * 0.08
    smudge = blobs(size, 26, 10, 28, aspect=0.6)              # greasy finger / palm marks: shinier
    scuff = blobs(size, 10, 20, 60, aspect=0.15)              # long dull scuffs from sleeves / papers
    rough = rough - 0.30 * smudge + 0.18 * scuff
    height = np.zeros((size, size), np.float32)
    for _ in range(28):                                       # fine scratches: short straight lines
        x0, y0 = RNG.random() * size, RNG.random() * size
        a, ln = RNG.random() * np.pi, 15 + RNG.random() * 60
        for k in np.linspace(0, 1, int(ln)):
            xi, yi = int(x0 + np.cos(a) * ln * k) % size, int(y0 + np.sin(a) * ln * k) % size
            height[yi, xi] -= 0.35
    height = blur(height, 1)
    rough = np.clip(rough - 0.12 * (height < -0.05), 0.15, 1)
    return comp(np.ones((size, size), np.float32), rough), normal_map(height, 3.0)


def floor_wear(size=1024):
    """Traffic wear over the carpet (alpha layer): matted dark paths and fuzzed light patches."""
    dark = np.clip((tile_noise(size, 3) - 0.45) * 2.2, 0, 1) * 0.30
    light = np.clip((tile_noise(size, 6) - 0.62) * 3.0, 0, 1) * 0.16
    rgba = np.zeros((size, size, 4), np.float32)
    col_dark, col_light = hexrgb("1A202A"), hexrgb("7C8594")
    mix = light / np.maximum(dark + light, 1e-6)
    for i in range(3):
        rgba[..., i] = col_dark[i] * (1 - mix) + col_light[i] * mix
    rgba[..., 3] = np.clip(dark + light, 0, 0.4) * 255
    return rgba


def glass_smudge(size=1024):
    """
    Inside-of-window dirt for one pane (stretched over it, v up). Tiles left / right so
    neighbouring panes can use shifted copies. Mostly clear: grime along the bottom,
    finger smudges at sill height, faint cleaning streaks, dust.
    """
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    up = 1.0 - y / size                                       # 0 at the bottom of the pane
    grime = np.clip(1 - up / 0.12, 0, 1) ** 1.6 * (0.55 + 0.45 * tile_noise(size, 12)) * 0.20
    fingers = blobs(size, 22, 8, 22, aspect=1.3) * np.clip(1 - np.abs(up - 0.12) / 0.10, 0, 1) * 0.10
    streak = np.zeros((size, size), np.float32)
    for _ in range(7):                                        # arcs left by a squeegee / cloth
        cx, cy, r = RNG.random() * size, size * (0.3 + RNG.random()), size * (0.25 + RNG.random() * 0.3)
        ddx = (x - cx + size / 2) % size - size / 2
        d = np.abs(np.sqrt(ddx ** 2 + (y - cy) ** 2) - r)
        streak = np.maximum(streak, np.clip(1 - d / 6, 0, 1) * (0.4 + 0.6 * RNG.random()))
    streak *= 0.035
    dust = blur((RNG.random((size, size)) > 0.9993).astype(np.float32), 1) * 0.5
    alpha = np.clip(grime + fingers + streak + dust, 0, 0.35)
    rgba = np.zeros((size, size, 4), np.float32)
    rgba[..., 0], rgba[..., 1], rgba[..., 2] = 196, 192, 182          # light grey-brown film
    rgba[..., 3] = alpha * 255
    return rgba


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    save(carpet(), out_dir, "TWR_Carpet_albd.png")
    save(ceiling(), out_dir, "TWR_Ceiling_albd.png")
    save(console(), out_dir, "TWR_Console_albd.png")
    save(keypad(), out_dir, "TWR_Keypad_albd.png")
    save(keyboard(), out_dir, "TWR_Keyboard_albd.png")
    save(speaker(), out_dir, "TWR_Speaker_albd.png")
    c, nrm = carpet_detail()
    save(c, out_dir, "TWR_Carpet_comp.png")
    save(nrm, out_dir, "TWR_Carpet_norm.png")
    c, nrm = console_detail()
    save(c, out_dir, "TWR_Console_comp.png")
    save(nrm, out_dir, "TWR_Console_norm.png")
    save(floor_wear(), out_dir, "TWR_FloorWear_albd.png")
    save(glass_smudge(), out_dir, "TWR_GlassSmudge_albd.png")
    print("Wrote", ", ".join(sorted(TEXTURES)), "to", out_dir)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
