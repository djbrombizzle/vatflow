// DCA Tower Cab: checks the package hangs together (no sim needed).
//   node dca-tower-cab/tools/test_dca_cab.mjs
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const COMMON = new URL("package/SimObjects/Airplanes/vatflow_dca_tower_cab/common/", ROOT);
const INSTR = new URL("package/html_ui/Pages/VCockpit/Instruments/", ROOT);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

const panel = readFileSync(new URL("panel/panel.cfg", COMMON), "utf8");
const build = readFileSync(new URL("blender/build_dca_tower_cab.py", ROOT), "utf8");
const xml = readFileSync(new URL("model/dca_tower_cab_interior.xml", COMMON), "utf8");
const gltf = JSON.parse(readFileSync(new URL("model/dca_tower_cab_interior.gltf", COMMON), "utf8"));

t("panel.cfg: each screen has its $SCREEN material in the build and the model, and its page exists", () => {
  const screens = [...panel.matchAll(/^texture=(\$SCREEN_\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(screens, ["$SCREEN_DBRITE", "$SCREEN_ASDEX"]);
  const mats = gltf.materials.map((m) => m.name);
  for (const s of screens) {
    assert.ok(build.includes('"' + s + '"'), s + " in the build script");
    assert.ok(mats.includes(s), s + " in the exported model");
  }
  for (const m of panel.matchAll(/^htmlgauge00=(VatflowDcaTower\/[\w/]+\.html)/gm)) {
    const page = readFileSync(new URL(m[1], INSTR), "utf8");
    for (const imp of page.matchAll(/(?:import-script|href)="\/Pages\/VCockpit\/Instruments\/([^"]+)"/g)) {
      assert.ok(imp[1].startsWith("VatflowDcaTower/"), m[1] + " loads only its own package's files: " + imp[1]);
      assert.ok(existsSync(new URL(imp[1], INSTR)), m[1] + " -> " + imp[1] + " exists");
    }
  }
});

t("screens: own folder, no paths into the VATFLOW Tower Cab's except the shared ARTCC maps", () => {
  const walk = (u) => readdirSync(u).flatMap((f) => {
    const c = new URL(f, u);
    return statSync(c).isDirectory() ? walk(new URL(f + "/", u)) : [c];
  });
  for (const f of walk(new URL("VatflowDcaTower/", INSTR))) {
    if (!/\.(js|html|css)$/.test(f.pathname)) continue;
    const bad = readFileSync(f, "utf8").match(/Instruments\/VatflowTower\/(?!facilities\/)/);
    assert.equal(bad, null, f.pathname);
  }
});

t("overhead monitors: track, height and swivel behaviours on both, screens not draggable", () => {
  for (const [m, cap] of [["DBRITE", "Dbrite"], ["ASDEX", "Asdex"]]) {
    const comp = (part) => (new RegExp(`Node="TowerCab_${cap}Mount${part}">([\\s\\S]*?)</Component>`).exec(xml) || [])[1] || "";
    assert.match(comp(""), new RegExp(`<ANIM_CODE>\\(L:VATFLOW_${m}_TRACK_DEG\\) dnor</ANIM_CODE>`), m + " track animation");
    assert.match(comp("_Lift"), new RegExp(`<POSITION_VAR>VATFLOW_${m}_TRACK_DEG</POSITION_VAR>`), m + " drag the post along the track");
    assert.match(comp("_Handle"), new RegExp(`<POSITION_VAR>VATFLOW_${m}_HEIGHT</POSITION_VAR>`), m + " height");
    for (const k of ["_SwivelL", "_SwivelR"]) assert.match(comp(k), new RegExp(`<POSITION_VAR>VATFLOW_${m}_TWIST</POSITION_VAR>`), m + k);
    assert.ok(comp("_Display") && !/Dragging/.test(comp("_Display")), m + " display: clicks reach the page");
    const anims = gltf.animations.map((a) => a.name);
    for (const a of ["_TRACK", "_Lift_LIFT", "_Display_TWIST"]) assert.ok(anims.includes(`TowerCab_${cap}Mount${a}`), m + a);
  }
});

t("window shades: one per window (8, the VATFLOW cab's octagon), 20 strips and a roller each", () => {
  const nodes = new Set(gltf.nodes.map((x) => x.name));
  for (let k = 0; k < 8; k++) {
    assert.ok(nodes.has(`TowerCab_ShadeRoller_${k}`) && xml.includes(`Node="TowerCab_ShadeRoller_${k}"`), "roller " + k);
    for (let s = 0; s < 20; s++) {
      const id = String(s).padStart(2, "0");
      assert.ok(xml.includes(`Node="TowerCab_Shade_${k}_s${id}"`) && xml.includes(`Node="TowerCab_ShadeBar_${k}_s${id}"`), `shade ${k} strip ${id}`);
    }
  }
  assert.ok(!nodes.has("TowerCab_ShadeRoller_8"));
});

t("layout: every DCA position is placed, GC on the front window, the islands are consoles", () => {
  const perim = /PERIMETER_POSITIONS = \[([\s\S]*?)\]\n/.exec(build)[1];
  for (const p of ["GC", "ALCN", "LCN", "ALCS", "LCS", "TMTW"]) assert.match(perim, new RegExp(`"${p}", \\d`), p);
  assert.match(perim, /\("GC", 0, 0\.0\)/, "GC: face 0 (front window), centred");
  for (const p of ["HC_FD", "CD", "NCH", "ISLAND", "ASTW", "RWALL", "TURRET"]) {
    assert.ok(gltf.nodes.some((x) => x.name === "TowerCab_Console_" + p), p);
  }
  for (const p of ["TowerCab_Consoles", "TowerCab_Stairs", "TowerCab_Kitchen", "TowerCab_CoreWalls"]) {
    assert.ok(gltf.nodes.some((x) => x.name === p), p);
  }
});

t("model files and names", () => {
  const cfg = readFileSync(new URL("model/model.cfg", COMMON), "utf8");
  assert.match(cfg, /normal=dca_tower_cab\.xml/);
  assert.match(cfg, /interior=dca_tower_cab_interior\.xml/);
  for (const f of ["dca_tower_cab.gltf", "dca_tower_cab.bin", "dca_tower_cab_interior.bin", "dca_tower_cab.xml"]) {
    assert.ok(existsSync(new URL("model/" + f, COMMON)), f);
  }
  for (const img of gltf.images) assert.ok(existsSync(new URL("texture/" + img.uri, COMMON)), img.uri);
  const setup = readFileSync(new URL("distribution/setup-project.ps1", ROOT), "utf8");
  assert.match(setup, /title = "DCA Tower Cab"/);
  assert.match(setup, /\$Ac = "vatflow_dca_tower_cab"/);
});

console.log(`\n${n} tests passed`);
