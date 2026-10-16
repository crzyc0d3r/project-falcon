import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ROUNDS,
  again,
  canSend,
  createState,
  send,
  showClearControls,
  SOLIDS,
} from "./rules.js";
import { HIT_RADIUS_PX, formatTap, judgeTap, pickTapInfo, tapRecord } from "./hit.js";

// OrbitControls is vendored for the offline Android bundle. Turning the shape
// is our own pointer drag (see the gesture code): up to 8px is a tap, more turns it.
void OrbitControls;

// Movement up to 8px is a tap; more is a drag.
const TAP_PX = 8;
// Tap radius lives in hit.js (22 CSS px: a 44px touch area around every line).
// One even stroke weight for every line, in cell units (a cell is 1x1).
const RIBBON_W = 0.3;
// Arrowheads clearly bigger and wider than the 0.3 stroke so direction reads at a glance.
const HEAD_LEN = 0.62;
const HEAD_W = 0.94;
// The head tip sits this far past the head cell's centre, still inside the cell.
const HEAD_LEAD = 0.3;
// Shape fills about this share of the view width on a phone.
const FIT_W = 0.7;
// Near/far ink cut-off on the face-normal . to-camera dot product.
const NEAR_DOT = 0.02;
const LIFT = 0.035;
const GLASS_OPACITY = 0.84;
const PAPER_COLORS = [0xffffff, 0xf3f6fb, 0xe3ecf5];

const black = new THREE.MeshBasicMaterial({
  color: 0x000000,
  // FrontSide only: hiding far paper used to reveal DoubleSide undersides as false "far" black.
  side: THREE.FrontSide,
  transparent: true,
  opacity: 1,
  depthWrite: true,
  depthTest: true,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
});
// Far-side arrows show as pale ghosts through the paper; drawn after the paper, under near ink.
// Glass: far-side arrows show faintly through the white faces (as in Pat's
// video). Drawn after the paper and under near ink, so near lines stay crisp.
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0x7f90a6,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.16,
  depthTest: false,
  depthWrite: false,
});
// Tap feedback colours (whole line).
const GOOD_BLUE = 0x2f7bf5;
const BAD_RED = 0xe5484d;
function tintMat(color) {
  const m = black.clone();
  m.color.setHex(color);
  return m;
}
const GOOD_SLIDE_MS = 700;
const GOOD_LIFT_MS = 300;
// Past the face edge the line keeps going STRAIGHT in its own face plane (head
// direction, no normal component, no bend) into empty space while it fades.
const BAD_SHAKE_MS = 300;
const BAD_SHAKE_AMP = 0.14;
const frameMat = new THREE.MeshBasicMaterial({ color: 0x8ea0b3, side: THREE.DoubleSide, depthTest: true, depthWrite: true });
// Thin crease. Transparent so it paints after the paper, depth-tested so it sits on the face.
const seamMat = new THREE.MeshBasicMaterial({
  color: 0x111111,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 1,
  depthTest: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
function makeBackingMat() {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}
// Ink of a line past its face edge ("air"): drawn on top of everything (no depth
// test, high render order) so it never vanishes behind a neighbour face and pops
// back; it may overlap that face visually but is never part of its grid. Each
// vertex carries its own alpha (fades out by distance past the edge, see
// fadePastEdge). Cached per base material; opacity kept in step.
const AIR_ORDER = 8;
const FADE_CELLS = 2;
function airMat(base) {
  let m = base.userData.airMat;
  if (!m) {
    m = base.clone();
    m.depthTest = false;
    m.depthWrite = false;
    m.transparent = true;
    m.vertexColors = true;
    m.polygonOffset = false;
    base.userData.airMat = m;
    const dispose = base.dispose.bind(base);
    base.dispose = () => {
      m.dispose();
      dispose();
    };
  }
  m.opacity = base.opacity;
  return m;
}
// Per-vertex alpha for an air mesh by distance d past the edge (along the exit
// direction, in the face plane): ease-out (1 - d/2)^2, so 1.0 at the edge, 0.25 at
// 1 cell (never solid over a neighbour face), 0 at FADE_CELLS = 2 cells.
// Alpha is set per vertex, so strips are subdivided finely enough (see
// AIR_STEP) for the curve to show between vertices.
const AIR_STEP = 0.1;
function airAlpha(d) {
  const t = Math.max(0, Math.min(1, 1 - Math.max(0, d) / FADE_CELLS));
  return t * t;
}
function fadePastEdge(mesh, edge, dir) {
  const pos = mesh.geometry.getAttribute("position");
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const past = (pos.getX(i) - edge[0]) * dir[0] + (pos.getY(i) - edge[1]) * dir[1] + (pos.getZ(i) - edge[2]) * dir[2];
    col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 1;
    col[i * 4 + 3] = airAlpha(past);
  }
  mesh.geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
}
function inkFor(obj, near, ink) {
  const base = near ? ink : ghostMat;
  return obj.userData.air ? airMat(base) : base;
}
function makePaperMat(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: GLASS_OPACITY,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });
}
// SOLIDS (one box list per round, in cell units) comes from rules.js.

const viewEl = document.getElementById("view");
const pipsEl = document.getElementById("pips");
const doneEl = document.getElementById("done");
// Arrows-left chip. Off in the shipped build (Pat hasn't decided); ?counter=1 turns
// it on for local review only. When on, the pips move up under the chip.
const SHOW_COUNTER = false;
const counterOn = SHOW_COUNTER || new URLSearchParams(location.search).get("counter") === "1";
let countEl = null;
if (counterOn) {
  const top = document.createElement("div");
  top.id = "top";
  countEl = document.createElement("div");
  countEl.id = "count";
  countEl.className = "chip";
  // Keep the bottom bar's height so the view (and camera fit) is unchanged.
  const spacer = document.createElement("div");
  spacer.className = "pips-spacer";
  pipsEl.replaceWith(spacer);
  top.append(countEl, pipsEl);
  document.body.appendChild(top);
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setClearColor(0xd7e6f4, 1);
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.sortObjects = true;
viewEl.appendChild(renderer.domElement);
// No browser panning / zooming / scrolling may steal a drag (CSS sets this too).
renderer.domElement.style.touchAction = "none";
viewEl.style.touchAction = "none";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xd7e6f4);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
const turntable = new THREE.Group();
const content = new THREE.Group();
turntable.add(content);
scene.add(turntable);

// Three-quarter start for every round: three faces of the body show at once,
// tilted down about 30 degrees, so nothing starts flat-on.
const VIEWS = [
  { x: 0.5, y: -0.66, z: 0 },
  { x: 0.48, y: -0.72, z: 0 },
  // Cross: looks down ~30 degrees in total (0.33 rad tilt plus the camera's own
  // ~11 degree lift) so every arm top shows, and yawed ~20 degrees so the left
  // side faces show. Seen from the left, the right arm sits behind the bar.
  { x: 0.33, y: 0.35, z: 0 },
];
// Orientation of the shape is a quaternion (trackball): a drag turns it about
// the camera's own screen axes, so there is no pitch clamp and no gimbal lock;
// every drag in every direction turns it. Each round starts from its signed view
// (VIEWS, XYZ Euler). rotX / rotY only accumulate total drag angle (review/tests).
let rotX = VIEWS[0].x;
let rotY = VIEWS[0].y;
let rotZ = VIEWS[0].z;
const viewQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotX, rotY, rotZ || 0, "XYZ"));
let state = createState();
// Local review only: ?round=0|1|2 jumps to that round for screenshots.
const roundQuery = new URLSearchParams(location.search).get("round");
if (roundQuery !== null) {
  const n = Math.max(0, Math.min(ROUNDS.length - 1, Number(roundQuery) | 0));
  state.roundIndex = n;
  state.alive = ROUNDS[n].paths.map((p) => p.id);
  state.won = false;
}

// Taps are never queued or dropped. Each tap is judged at once against the live
// rule state; animations only show what already happened and run side by side.
let glide = null; // drag glide after release: { vx, vy, t } in px/ms
const flying = new Set(); // ids whose fly-off is still playing (not tappable)
const flyStart = new Map(); // id -> performance.now() when its fly-off started
// While a finished board is still on screen (advance / win / reset waiting for its
// last animations), the HUD shows that board's end state: 0 arrows left after the
// last clear, 0 pips during the shake that resets the round.
let hudHold = null;
let inFlight = 0; // tap animations (fly-offs + shakes) still playing
let pendingBuild = false; // round over (advance / win / reset): rebuild when anims end
const pathGroups = new Map();
const anims = [];
let glassFaces = [];
let roundFaces = [];

function boxCenter(index) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const [a, b] of SOLIDS[index]) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], a[k]);
      hi[k] = Math.max(hi[k], b[k]);
    }
  }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

function dist3(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.hypot(dx, dy, dz);
}

function polyLen(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist3(pts[i - 1], pts[i]);
  return n;
}

function pointAlong(pts, dist) {
  if (dist <= 0) return pts[0].slice();
  let remain = dist;
  for (let i = 1; i < pts.length; i++) {
    const L = dist3(pts[i - 1], pts[i]);
    if (remain <= L || i === pts.length - 1) {
      const t = L === 0 ? 0 : remain / L;
      const a = pts[i - 1];
      const b = pts[i];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    remain -= L;
  }
  return pts[pts.length - 1].slice();
}

function slicePolyline(pts, d0, d1) {
  const out = [pointAlong(pts, d0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = dist3(pts[i - 1], pts[i]);
    const next = acc + L;
    if (next > d0 + 1e-4 && next < d1 - 1e-4) out.push(pts[i].slice());
    acc = next;
    if (acc >= d1 - 1e-6) break;
  }
  const end = pointAlong(pts, d1);
  const prev = out[out.length - 1];
  if (dist3(prev, end) > 1e-4) out.push(end);
  return out;
}

function extendRoute(points, continuation) {
  // Keep the exit step for animation travel, but do not extend a long off-solid ray.
  // Drawing clamps to the on-face portion in setOffset/fillPathGroup.
  return points.concat(continuation).map((p) => p.slice());
}

function pointYAt(obj, dir) {
  const d = dir.clone().normalize();
  if (d.dot(new THREE.Vector3(0, 1, 0)) < -0.999) {
    obj.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  } else {
    obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  }
}

function addCylinder(parent, a, b, radius, material) {
  const va = new THREE.Vector3(a[0], a[1], a[2]);
  const vb = new THREE.Vector3(b[0], b[1], b[2]);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  if (len < 1e-6) return;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6, 1), material);
  mesh.position.copy(va).add(vb).multiplyScalar(0.5);
  pointYAt(mesh, dir);
  parent.add(mesh);
}

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
  });
}

function dedupe3(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || dist3(out[out.length - 1], p) > 1e-4) out.push(p.slice());
  }
  return out;
}

function trimEnd(pts, amount) {
  const out = pts.map((p) => p.slice());
  let remain = amount;
  while (out.length >= 2 && remain > 1e-6) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    const L = dist3(a, b);
    if (L > remain + 1e-6) {
      const t = (L - remain) / L;
      out[out.length - 1] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
      remain = 0;
    } else {
      remain -= L;
      out.pop();
    }
  }
  return out;
}

function solidCells(boxes) {
  const cells = new Set();
  for (const [[x0, y0, z0], [x1, y1, z1]] of boxes) {
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        for (let z = z0; z < z1; z++) cells.add(x + "," + y + "," + z);
      }
    }
  }
  return cells;
}

function mergeRects(pairs) {
  const set = new Set(pairs.map(([u, v]) => u + "," + v));
  const used = new Set();
  const rects = [];
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [u, v] of sorted) {
    if (used.has(u + "," + v)) continue;
    let u1 = u + 1;
    while (set.has(u1 + "," + v) && !used.has(u1 + "," + v)) u1++;
    let v1 = v + 1;
    for (;;) {
      let row = true;
      for (let uu = u; uu < u1; uu++) {
        if (!set.has(uu + "," + v1) || used.has(uu + "," + v1)) row = false;
      }
      if (!row) break;
      v1++;
    }
    for (let uu = u; uu < u1; uu++) {
      for (let vv = v; vv < v1; vv++) used.add(uu + "," + vv);
    }
    rects.push([u, v, u1, v1]);
  }
  return rects;
}


function pushTriToward(positions, a, b, c, normal) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const cx = aby * acz - abz * acy;
  const cy = abz * acx - abx * acz;
  const cz = abx * acy - aby * acx;
  const toward = cx * normal[0] + cy * normal[1] + cz * normal[2];
  if (toward >= 0) positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  else positions.push(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2]);
}

function pushQuad(positions, corners) {
  for (const i of [0, 1, 2, 0, 2, 3]) positions.push(corners[i][0], corners[i][1], corners[i][2]);
}

function axesFor(axis) {
  if (axis === 0) return [1, 2];
  if (axis === 1) return [0, 2];
  return [0, 1];
}

function collectFaces(index) {
  const boxes = SOLIDS[index];
  const cells = solidCells(boxes);
  const faces = [];
  for (const [[x0, y0, z0], [x1, y1, z1]] of boxes) {
    const specs = [
      { axis: 0, sign: -1, value: x0, u0: y0, u1: y1, v0: z0, v1: z1 },
      { axis: 0, sign: 1, value: x1, u0: y0, u1: y1, v0: z0, v1: z1 },
      { axis: 1, sign: -1, value: y0, u0: x0, u1: x1, v0: z0, v1: z1 },
      { axis: 1, sign: 1, value: y1, u0: x0, u1: x1, v0: z0, v1: z1 },
      { axis: 2, sign: -1, value: z0, u0: x0, u1: x1, v0: y0, v1: y1 },
      { axis: 2, sign: 1, value: z1, u0: x0, u1: x1, v0: y0, v1: y1 },
    ];
    for (const spec of specs) {
      const pairs = [];
      const [uAxis, vAxis] = axesFor(spec.axis);
      for (let u = spec.u0; u < spec.u1; u++) {
        for (let v = spec.v0; v < spec.v1; v++) {
          const cell = [0, 0, 0];
          cell[spec.axis] = spec.value + (spec.sign > 0 ? -1 : 0);
          cell[uAxis] = u;
          cell[vAxis] = v;
          const next = cell.slice();
          next[spec.axis] += spec.sign;
          if (cells.has(next.join(","))) continue;
          pairs.push([u, v]);
        }
      }
      for (const rect of mergeRects(pairs)) {
        const normal = [0, 0, 0];
        normal[spec.axis] = spec.sign;
        const point = [0, 0, 0];
        point[spec.axis] = spec.value;
        point[uAxis] = (rect[0] + rect[2]) / 2;
        point[vAxis] = (rect[1] + rect[3]) / 2;
        faces.push({
          axis: spec.axis,
          sign: spec.sign,
          value: spec.value,
          rects: [rect],
          area: (rect[2] - rect[0]) * (rect[3] - rect[1]),
          normal,
          point,
          uAxis,
          vAxis,
        });
      }
    }
  }
  return faces;
}

function solidEdges(index) {
  // Every edge of every box, including shared faces at joins (drawn once each).
  const segs = [];
  const seen = new Set();
  for (const [[x0, y0, z0], [x1, y1, z1]] of SOLIDS[index]) {
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1],
    ];
    const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [i, j] of pairs) {
      const a = corners[i];
      const b = corners[j];
      const k = [a.join(","), b.join(",")].sort().join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      segs.push([a.slice(), b.slice()]);
    }
  }
  return segs;
}

function addSeams(index) {
  const group = new THREE.Group();
  group.name = "seams";
  const seenV = new Set();
  const R = 0.03;
  for (const [a, b] of solidEdges(index)) {
    addCylinder(group, a, b, R, seamMat);
    for (const v of [a, b]) {
      const k = v.join(",");
      if (seenV.has(k)) continue;
      seenV.add(k);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(R, 8, 6), seamMat);
      joint.position.set(v[0], v[1], v[2]);
      group.add(joint);
    }
  }
  group.traverse((obj) => {
    if (obj.isMesh) obj.renderOrder = 8;
  });
  return group;
}

// ---- Unbroken arrows -------------------------------------------------------
// Paths are lists of surface-cell centres. Between two cells on different faces
// the line runs to the shared edge and bends over it, so one arrow is one
// continuous ribbon even when it wraps a corner.

let roundVox = new Set();

function isInt(x) {
  return Math.abs(x - Math.round(x)) < 1e-6;
}

// Outward normal of the face a cell-centre point lies on, or null if the point is
// not on the surface (the off-step in the air).
function cellNormal(p) {
  const k = [0, 1, 2].find((i) => isInt(p[i]));
  if (k === undefined) return null;
  const lo = p.map((v, i) => (i === k ? Math.round(v) - 1 : Math.floor(v)));
  const hi = p.map((v, i) => (i === k ? Math.round(v) : Math.floor(v)));
  const a = roundVox.has(lo.join(","));
  const b = roundVox.has(hi.join(","));
  if (a === b) return null;
  const n = [0, 0, 0];
  n[k] = a ? 1 : -1;
  return n;
}

// Centreline with per-segment face normals. `extend` adds a straight run past the
// last point (into the air) for the slide-off animation.
function expandLine(cells, extend) {
  const pts = [cells[0].slice()];
  const nrm = [];
  let carry = cellNormal(cells[0]) || [0, 1, 0];
  for (let i = 1; i < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const na = cellNormal(a) || carry;
    const nb = cellNormal(b) || na;
    const diff = [0, 1, 2].filter((k) => Math.abs(a[k] - b[k]) > 1e-6);
    if (diff.length === 2) {
      const m = a.slice();
      for (const k of diff) m[k] = isInt(a[k]) ? a[k] : b[k];
      pts.push(m);
      nrm.push(na);
      pts.push(b.slice());
      nrm.push(nb);
    } else {
      pts.push(b.slice());
      nrm.push(na);
    }
    carry = nb;
  }
  if (extend > 0 && pts.length >= 2) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    pts.push([b[0] + (d[0] / L) * extend, b[1] + (d[1] / L) * extend, b[2] + (d[2] / L) * extend]);
    nrm.push(nrm[nrm.length - 1]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist3(pts[i - 1], pts[i]));
  return { pts, nrm, cum, len: cum[cum.length - 1] };
}

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function sameN(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

// Window [s0, s1] of a line, split into runs that each lie flat on one face.
// Each run point carries its arc position s. Edge joints are lifted along both
// normals so the two runs meet exactly over the crease.
function windowRuns(line, s0, s1) {
  const runs = [];
  for (let i = 0; i < line.pts.length - 1; i++) {
    const a0 = line.cum[i];
    const a1 = line.cum[i + 1];
    if (a1 <= s0 + 1e-6 || a0 >= s1 - 1e-6 || a1 - a0 < 1e-9) continue;
    const t0 = Math.max(0, (s0 - a0) / (a1 - a0));
    const t1 = Math.min(1, (s1 - a0) / (a1 - a0));
    const p0 = lerp3(line.pts[i], line.pts[i + 1], t0);
    const p1 = lerp3(line.pts[i], line.pts[i + 1], t1);
    const n = line.nrm[i];
    const last = runs[runs.length - 1];
    if (last && sameN(last.n, n)) {
      last.pts.push(p1);
      last.s.push(a0 + (a1 - a0) * t1);
    } else {
      runs.push({ n, pts: [p0, p1], s: [a0 + (a1 - a0) * t0, a0 + (a1 - a0) * t1] });
    }
  }
  for (const r of runs) r.lifted = r.pts.map((p) => [p[0] + r.n[0] * LIFT, p[1] + r.n[1] * LIFT, p[2] + r.n[2] * LIFT]);
  for (let i = 1; i < runs.length; i++) {
    const A = runs[i - 1];
    const B = runs[i];
    if (dist3(A.pts[A.pts.length - 1], B.pts[0]) > 1e-6) continue;
    const m = B.pts[0];
    const j = [m[0] + (A.n[0] + B.n[0]) * LIFT, m[1] + (A.n[1] + B.n[1]) * LIFT, m[2] + (A.n[2] + B.n[2]) * LIFT];
    A.lifted[A.lifted.length - 1] = j;
    B.lifted[0] = j.slice();
  }
  return runs;
}

// Flat strip on one face; halfW(s) gives the half width at arc position s.
function stripMesh(run, halfW, kind) {
  const P = run.lifted;
  if (P.length < 2) return null;
  const n = new THREE.Vector3(run.n[0], run.n[1], run.n[2]);
  const segSide = [];
  for (let i = 0; i < P.length - 1; i++) {
    const t = new THREE.Vector3(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]);
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    segSide.push(new THREE.Vector3().crossVectors(n, t.normalize()).normalize());
  }
  const L = [];
  const Rr = [];
  for (let i = 0; i < P.length; i++) {
    let side;
    if (i === 0) side = segSide[0].clone();
    else if (i === P.length - 1) side = segSide[segSide.length - 1].clone();
    else {
      side = segSide[i - 1].clone().add(segSide[i]);
      if (side.lengthSq() < 1e-8) side = segSide[i].clone();
      side.normalize();
      const dot = Math.max(0.5, side.dot(segSide[i]));
      side.multiplyScalar(1 / dot);
    }
    const w = halfW(run.s[i]);
    const p = new THREE.Vector3(P[i][0], P[i][1], P[i][2]);
    L.push(p.clone().addScaledVector(side, w).toArray());
    Rr.push(p.clone().addScaledVector(side, -w).toArray());
  }
  const positions = [];
  for (let i = 0; i < P.length - 1; i++) {
    pushTriToward(positions, L[i], Rr[i], L[i + 1], run.n);
    pushTriToward(positions, Rr[i], Rr[i + 1], L[i + 1], run.n);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geom, black);
  mesh.userData.kind = kind;
  const mid = P[Math.floor(P.length / 2)];
  rememberFace(mesh, { normal: run.n, point: mid });
  return mesh;
}

function tailCap(run, s) {
  // Round tail so a line end reads as the start of a stroke, not a cut.
  const p = run.lifted[0];
  const q = run.lifted[1];
  const n = new THREE.Vector3(run.n[0], run.n[1], run.n[2]);
  const back = new THREE.Vector3(p[0] - q[0], p[1] - q[1], p[2] - q[2]).normalize();
  const side = new THREE.Vector3().crossVectors(n, back).normalize();
  const c = new THREE.Vector3(p[0], p[1], p[2]);
  const positions = [];
  const K = 8;
  const half = RIBBON_W / 2;
  for (let k = 0; k < K; k++) {
    const a0 = Math.PI * (k / K);
    const a1 = Math.PI * ((k + 1) / K);
    const e0 = c.clone().addScaledVector(side, Math.cos(a0) * half).addScaledVector(back, Math.sin(a0) * half);
    const e1 = c.clone().addScaledVector(side, Math.cos(a1) * half).addScaledVector(back, Math.sin(a1) * half);
    pushTriToward(positions, c.toArray(), e0.toArray(), e1.toArray(), run.n);
  }
  void s;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geom, black);
  mesh.userData.kind = "shaft";
  rememberFace(mesh, { normal: run.n, point: p });
  return mesh;
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    if (child.geometry) child.geometry.dispose();
  }
}

// The track a cleared arrow snakes along: its own cells, the cells straight ahead
// on its face, the face edge, then straight on past the edge in the face's own
// plane (along the head direction, no normal component, no bend). Every point of
// the line follows this track, so the tail goes round its own bends exactly where
// the head went, then leaves along the same straight line.
function exitTrack(path, body) {
  const cells = path.points.concat(path.continuation.slice(0, -1));
  const line = expandLine(cells, 0);
  const a = line.pts[line.pts.length - 2];
  const b = line.pts[line.pts.length - 1];
  const n = line.nrm[line.nrm.length - 1];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dl = Math.hypot(d[0], d[1], d[2]) || 1;
  for (let k = 0; k < 3; k++) d[k] /= dl;
  const edge = [b[0] + d[0] * 0.5, b[1] + d[1] * 0.5, b[2] + d[2] * 0.5];
  const far = body.len + HEAD_LEAD + 2;
  line.pts.push(edge, [edge[0] + d[0] * far, edge[1] + d[1] * far, edge[2] + d[2] * far]);
  line.nrm.push(n, n);
  line.cum = [0];
  for (let i = 1; i < line.pts.length; i++) line.cum.push(line.cum[i - 1] + dist3(line.pts[i - 1], line.pts[i]));
  line.len = line.cum[line.cum.length - 1];
  line.edgeAt = line.cum[line.cum.length - 2];
  return line;
}

function setOffset(id, offset) {
  const rec = pathGroups.get(id);
  if (!rec) return;
  clearGroup(rec.group);
  const s0 = offset;
  const s1 = offset + rec.bodyLen + HEAD_LEAD;
  if (s0 >= rec.route.len - 1e-3) return;
  const headStart = s1 - HEAD_LEN;
  // Split at the face edge: on-face ink as before; the part past the edge is
  // marked `air`: drawn on top, fading out by distance past the edge (see airMat).
  const edgeAt = rec.route.edgeAt;
  const E = rec.route.pts[rec.route.pts.length - 2];
  const F = rec.route.pts[rec.route.pts.length - 1];
  const FL = Math.hypot(F[0] - E[0], F[1] - E[1], F[2] - E[2]) || 1;
  const D = [(F[0] - E[0]) / FL, (F[1] - E[1]) / FL, (F[2] - E[2]) / FL];
  // Air runs are subdivided every AIR_STEP so the per-vertex fade follows the curve.
  const densify = (run) => {
    const P = [], L = [], S = [];
    for (let i = 0; i < run.pts.length - 1; i++) {
      const k = Math.max(1, Math.ceil((run.s[i + 1] - run.s[i]) / AIR_STEP));
      for (let j = 0; j < k; j++) {
        P.push(lerp3(run.pts[i], run.pts[i + 1], j / k));
        L.push(lerp3(run.lifted[i], run.lifted[i + 1], j / k));
        S.push(run.s[i] + ((run.s[i + 1] - run.s[i]) * j) / k);
      }
    }
    P.push(run.pts[run.pts.length - 1]);
    L.push(run.lifted[run.lifted.length - 1]);
    S.push(run.s[run.s.length - 1]);
    return { ...run, pts: P, lifted: L, s: S };
  };
  const markAir = (m, air) => {
    m.userData.air = air;
    if (air) fadePastEdge(m, E, D);
  };
  const parts = (a, b) => [[a, Math.min(b, edgeAt), false], [Math.max(a, edgeAt), b, true]].filter(([x, y]) => y - x > 1e-6);
  let first = true;
  for (const [a, b, air] of parts(s0, headStart + 0.02)) {
    for (const r0 of windowRuns(rec.route, a, b)) {
      const run = air ? densify(r0) : r0;
      const m = stripMesh(run, () => RIBBON_W / 2, "shaft");
      if (m) {
        markAir(m, air);
        rec.group.add(m);
      }
      if (first && run.lifted.length >= 2) {
        const cap = tailCap(run, s0);
        markAir(cap, air);
        rec.group.add(cap);
      }
      first = false;
    }
  }
  for (const [a, b, air] of parts(headStart, s1)) {
    for (const r0 of windowRuns(rec.route, a, b)) {
      const run = air ? densify(r0) : r0;
      const m = stripMesh(run, (s) => (HEAD_W / 2) * Math.max(0, Math.min(1, (s1 - s) / HEAD_LEN)), "arrow");
      if (m) {
        markAir(m, air);
        rec.group.add(m);
      }
    }
  }
  orientGroup(rec.group);
}

function orientGroup(group) {
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.userData.faceNormal) return;
    const near = faceTowardCamera(obj.userData.faceNormal, obj.userData.facePoint);
    obj.material = inkFor(obj, near, group.userData.inkMat || black);
    obj.renderOrder = obj.userData.air ? AIR_ORDER : near ? (obj.userData.kind === "arrow" ? 5 : 4) : 3;
  });
}

function clearContent() {
  for (const child of [...content.children]) {
    disposeGroup(child);
    content.remove(child);
  }
  pathGroups.clear();
  glassFaces = [];
  roundFaces = [];
}

function faceCorners(plane, p, a0, a1, b0, b1) {
  if (plane.axis === 0 && plane.sign > 0) return [[p, a0, b0], [p, a1, b0], [p, a1, b1], [p, a0, b1]];
  if (plane.axis === 0) return [[p, a0, b0], [p, a0, b1], [p, a1, b1], [p, a1, b0]];
  if (plane.axis === 1 && plane.sign > 0) return [[a0, p, b0], [a0, p, b1], [a1, p, b1], [a1, p, b0]];
  if (plane.axis === 1) return [[a0, p, b0], [a1, p, b0], [a1, p, b1], [a0, p, b1]];
  if (plane.sign > 0) return [[a0, b0, p], [a1, b0, p], [a1, b1, p], [a0, b1, p]];
  return [[a0, b0, p], [a0, b1, p], [a1, b1, p], [a1, b0, p]];
}

function paperColorForFace(face) {
  // After turntable rotation, bucket world normals into 3 cubic directions for shading.
  const n = new THREE.Vector3(face.normal[0], face.normal[1], face.normal[2]);
  n.applyQuaternion(turntable.quaternion);
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return PAPER_COLORS[0];
  if (ax >= ay && ax >= az) return PAPER_COLORS[1];
  return PAPER_COLORS[2];
}

function rememberFace(mesh, face) {
  mesh.userData.faceNormal = new THREE.Vector3(face.normal[0], face.normal[1], face.normal[2]);
  mesh.userData.facePoint = new THREE.Vector3(face.point[0], face.point[1], face.point[2]);
}

function addGlass(index) {
  const group = new THREE.Group();
  group.name = "glass";
  applyRot();
  for (const face of roundFaces.length ? roundFaces : collectFaces(index)) {
    const positions = [];
    for (const [u, v, u1, v1] of face.rects) {
      // Full paper. The crease is a thin line on top, not a gap that replaces the face.
      pushQuad(positions, faceCorners(face, face.value, u, u1, v, v1));
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const backing = new THREE.Mesh(geom, makeBackingMat());
    backing.renderOrder = 1;
    const mesh = new THREE.Mesh(geom, makePaperMat(paperColorForFace(face)));
    mesh.renderOrder = 2;
    group.add(backing);
    group.add(mesh);
    glassFaces.push({
      mesh,
      backing,
      normal: new THREE.Vector3(face.normal[0], face.normal[1], face.normal[2]),
      point: new THREE.Vector3(face.point[0], face.point[1], face.point[2]),
    });
  }
  return group;
}

function addFrame(edges) {
  const frame = new THREE.Group();
  const seen = new Set();
  for (const [a, b] of edges) {
    addCylinder(frame, a, b, 0.056, frameMat);
    for (const v of [a, b]) {
      const k = v.join(",");
      if (seen.has(k)) continue;
      seen.add(k);
      const joint = new THREE.Mesh(new THREE.SphereGeometry(0.056, 8, 6), frameMat);
      joint.position.set(v[0], v[1], v[2]);
      frame.add(joint);
    }
  }
  return frame;
}

function applyRoundView() {
  const v = VIEWS[state.roundIndex] || VIEWS[0];
  rotX = v.x;
  rotY = v.y;
  rotZ = v.z || 0;
  viewQ.setFromEuler(new THREE.Euler(rotX, rotY, rotZ, "XYZ"));
  applyRot();
}

function buildRound() {
  // Any fly-offs / shakes of the old board end with it.
  anims.length = 0;
  glide = null;
  flying.clear();
  flyStart.clear();
  hudHold = null;
  inFlight = 0;
  pendingBuild = false;
  clearContent();
  const index = state.roundIndex;
  const round = ROUNDS[index];
  applyRoundView();
  roundFaces = collectFaces(index);
  content.add(addGlass(index));
  content.add(addSeams(index));
  void addFrame;
  roundVox = solidCells(SOLIDS[index]);
  for (const path of round.paths) {
    if (!state.alive.includes(path.id)) continue;
    const group = new THREE.Group();
    const body = expandLine(path.points, 0);
    const route = exitTrack(path, body);
    const rec = { group, body, route, bodyLen: body.len, points: path.points, continuation: path.continuation };
    pathGroups.set(path.id, rec);
    content.add(group);
  }
  const c = boxCenter(index);
  content.position.set(-c[0], -c[1], -c[2]);
  applyRot();
  fitCamera();
  for (const id of pathGroups.keys()) setOffset(id, 0);
  orientDraws();
  camera.updateMatrixWorld();
  renderer.render(scene, camera);
}

function applyRot() {
  // Start views are XYZ Euler (spin about the body's own vertical, then tilt), so
  // vertical edges stand upright at round start; drags then turn viewQ.
  turntable.quaternion.copy(viewQ);
}

function solidCorners(index) {
  const pts = [];
  for (const [[x0, y0, z0], [x1, y1, z1]] of SOLIDS[index]) {
    for (const x of [x0, x1]) {
      for (const y of [y0, y1]) {
        for (const z of [z0, z1]) pts.push([x, y, z]);
      }
    }
  }
  return pts;
}

function projectSpan(dist, corners) {
  camera.position.set(0, dist * 0.2, dist);
  camera.near = Math.max(0.05, dist / 100);
  camera.far = dist * 12;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  turntable.updateMatrixWorld(true);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const v = new THREE.Vector3(c[0], c[1], c[2]);
    content.localToWorld(v);
    if (v.z != null) {
      const eye = v.clone().applyMatrix4(camera.matrixWorldInverse);
      if (eye.z >= -0.01) continue;
    }
    v.project(camera);
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) return { w: 999, h: 999 };
  return { w: maxX - minX, h: maxY - minY };
}

function fitCamera() {
  const w = viewEl.clientWidth || 1;
  const h = viewEl.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const corners = solidCorners(state.roundIndex);
  // Shape width ~0.70 of the view (a 390px portrait).
  const targetW = FIT_W * 2; // NDC full width is 2
  const targetH = 0.84 * 2;
  let lo = 4;
  let hi = 200;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const span = projectSpan(mid, corners);
    const tooBig = span.w > targetW || span.h > targetH;
    if (tooBig) lo = mid;
    else hi = mid;
  }
  const span = projectSpan(hi, corners);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h, false);
  if (content.children.length) renderer.render(scene, camera);
}

function roundView() {
  return { paths: ROUNDS[state.roundIndex].paths, alive: state.alive };
}

function updateHud() {
  // Arrows left in this round: drops by one per clear, resets with each round.
  const left = hudHold ? hudHold.count : state.alive.length;
  const pips = hudHold ? hudHold.pips : state.pips;
  if (countEl) {
    countEl.textContent = String(left);
    countEl.setAttribute("aria-label", left + " arrows left");
  }
  pipsEl.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "pip" + (i < pips ? " on" : "");
    pipsEl.appendChild(dot);
  }
  if (showClearControls(state) && !pendingBuild) {
    if (!doneEl.querySelector("button")) {
      doneEl.replaceChildren();
      const label = document.createElement("p");
      label.className = "cleared";
      label.textContent = "Cleared";
      const button = document.createElement("button");
      button.type = "button";
      button.id = "again";
      button.textContent = "Again";
      button.addEventListener("click", onAgain);
      doneEl.append(label, button);
    }
  } else {
    doneEl.replaceChildren();
  }
}

function onAgain() {
  again(state);
  buildRound();
  updateHud();
}

// One tap animation finished: refresh the HUD (pips / counter drop when the
// motion ends, as before) and, once the board on screen is a finished round,
// rebuild it after its last animation.
function animDone() {
  inFlight = Math.max(0, inFlight - 1);
  if (pendingBuild && inFlight === 0) buildRound();
  updateHud();
}

// Tap log: one console.info line per tap; ?debug=1 shows the last 5 on screen.
const DEBUG = new URLSearchParams(location.search).get("debug") === "1";
const tapLog = [];
let debugEl = null;
if (DEBUG) {
  debugEl = document.createElement("pre");
  debugEl.id = "debug";
  debugEl.style.cssText = "position:fixed;left:6px;top:6px;margin:0;padding:4px 6px;max-width:94vw;font:10px/1.3 ui-monospace,monospace;color:#1d2b3a;background:rgba(255,255,255,0.85);border-radius:4px;pointer-events:none;z-index:9;white-space:pre-wrap";
  document.body.appendChild(debugEl);
}
function logTap(rec) {
  rec.t = Math.round(performance.now());
  tapLog.push(rec);
  if (tapLog.length > 500) tapLog.shift();
  const line = formatTap(rec);
  console.info("[falcon] " + line);
  if (debugEl) debugEl.textContent = tapLog.slice(-5).map(formatTap).join("\n");
}

function trySend(pathId, guarded = null) {
  const before = { count: state.alive.length, pips: state.pips };
  const judged = guarded ? null : judgeTap(state, send, pathId, flying, pendingBuild);
  logTap(tapRecord(pathId, { pips: before.pips, left: before.count }, judged, state, guarded));
  if (!judged) return;
  const { action, result } = judged;
  if (action === "none") return;
  if (result.reason === "advanced" || result.reason === "won" || result.reason === "reset") {
    pendingBuild = true;
    hudHold = result.reason === "reset" ? { count: before.count, pips: 0 } : { count: 0, pips: before.pips };
  }
  inFlight++;
  // Feedback is instant: the pip / counter change shows the moment the tap lands.
  updateHud();
  if (action === "fly") {
    flying.add(pathId);
    flyStart.set(pathId, performance.now());
    slideOff(pathId, () => {
      flying.delete(pathId);
      flyStart.delete(pathId);
      animDone();
    });
  } else {
    snapBack(pathId, animDone);
  }
}

// Head direction (unit, in the face plane) and face normal at an arrow's head.
function headFrame(rec) {
  const P = rec.body.pts;
  const a = P[P.length - 2];
  const b = P[P.length - 1];
  const n = rec.body.nrm[rec.body.nrm.length - 1];
  return {
    dir: new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize(),
    normal: new THREE.Vector3(n[0], n[1], n[2]),
  };
}

// Good tap (~1.0s): the whole line turns blue and snakes along its own track
// (every point follows the path, round the bends) until the head reaches the face
// edge (~0.7s); nothing is drawn off the face in that phase. Then it keeps snaking
// for ~0.3s: the part past the edge goes straight on in the face's own plane
// (head direction), drawn on top of everything, each point fading by its distance
// past the edge (1 at the edge, 0.25 at 1 cell, 0 at 2 cells); the on-face part
// stays solid while it snakes. Only ink moves; the face fill never changes.
function slideOff(id, done) {
  const rec = pathGroups.get(id);
  if (!rec) {
    done();
    return;
  }
  if (rec.stopShake) rec.stopShake();
  const mat = tintMat(GOOD_BLUE);
  rec.group.userData.inkMat = mat;
  const tipAt = rec.bodyLen + HEAD_LEAD;
  const toEdge = Math.max(0, rec.route.edgeAt - tipAt);
  // Done when the tail is FADE_CELLS past the edge: by then every point is fully
  // faded by distance, so removing the line shows no pop.
  const allOut = rec.route.edgeAt + FADE_CELLS + 0.05;
  const start = performance.now();
  setOffset(id, 0);
  // A head already at its edge (the usual case at round start, since every cell is
  // inked) has no run to slide along: the whole ~1.0s goes into one smooth snake
  // straight over the edge and out along the same line. Fading is by distance past
  // the edge only (starts the moment the head crosses it), no fade over time.
  const total = GOOD_SLIDE_MS + GOOD_LIFT_MS;
  const atEdge = toEdge < 1;
  anims.push((now) => {
    const t = now - start;
    if (atEdge) {
      const u = Math.min(1, t / total);
      setOffset(id, allOut * u * u * (3 - 2 * u));
      if (u < 1) return false;
      const group = rec.group;
      pathGroups.delete(id);
      disposeGroup(group);
      content.remove(group);
      mat.dispose();
      done();
      return true;
    }
    if (t < GOOD_SLIDE_MS) {
      const u = t / GOOD_SLIDE_MS;
      setOffset(id, toEdge * u * (2 - u));
      return false;
    }
    const u = Math.min(1, (t - GOOD_SLIDE_MS) / GOOD_LIFT_MS);
    setOffset(id, toEdge + (allOut - toEdge) * u);
    if (u < 1) return false;
    const group = rec.group;
    pathGroups.delete(id);
    disposeGroup(group);
    content.remove(group);
    mat.dispose();
    done();
    return true;
  });
}

// Blocked tap: the line turns red and shakes side to side three times (~0.3s),
// then goes back to black. The pip was already charged (and shown) at the tap.
function snapBack(id, done) {
  const rec = pathGroups.get(id);
  if (!rec) {
    done();
    return;
  }
  // A second blocked tap while this line still shakes restarts the shake (each
  // tap already cost its own pip in send()); the old shake ends quietly.
  if (rec.stopShake) rec.stopShake();
  const mat = tintMat(BAD_RED);
  rec.group.userData.inkMat = mat;
  // Shake along the arrow's own head direction, in the face's 3D plane, so the
  // ink stays on its track. Only the arrow's ink group moves; the face fill is
  // a separate mesh.
  const { dir } = headFrame(rec);
  const start = performance.now();
  orientGroup(rec.group);
  let stopped = false;
  const end = () => {
    rec.stopShake = null;
    rec.group.position.set(0, 0, 0);
    if (rec.group.userData.inkMat === mat) rec.group.userData.inkMat = null;
    orientGroup(rec.group);
    mat.dispose();
  };
  rec.stopShake = () => {
    stopped = true;
    end();
    done();
  };
  anims.push((now) => {
    if (stopped) return true;
    const u = Math.min(1, (now - start) / BAD_SHAKE_MS);
    rec.group.position.copy(dir).multiplyScalar(BAD_SHAKE_AMP * Math.sin(u * Math.PI * 6) * (1 - 0.35 * u));
    if (u < 1) return false;
    end();
    done();
    return true;
  });
}

function toScreen(local) {
  const v = new THREE.Vector3(local[0], local[1], local[2]);
  content.localToWorld(v);
  const eye = v.clone().applyMatrix4(camera.matrixWorldInverse);
  v.project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
    inFront: eye.z < 0,
  };
}


// Screen-space tap shape of a resting arrow: the polyline from tail to the head
// tip, plus the arrowhead triangle, on faces turned toward the camera only.
function tapShape(id) {
  const rec = pathGroups.get(id);
  if (!rec) return null;
  const line = rec.body;
  const segs = [];
  const near = (n, p) => faceTowardCamera(new THREE.Vector3(n[0], n[1], n[2]), new THREE.Vector3(p[0], p[1], p[2]));
  const pts = line.pts.map(toScreen);
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i].inFront && !pts[i - 1].inFront) continue;
    if (!near(line.nrm[i - 1], lerp3(line.pts[i - 1], line.pts[i], 0.5))) continue;
    segs.push([pts[i - 1], pts[i]]);
  }
  const { dir, normal } = headFrame(rec);
  const h = line.pts[line.pts.length - 1];
  const hv = new THREE.Vector3(h[0], h[1], h[2]);
  let head = null;
  if (near(normal.toArray(), h)) {
    const side = new THREE.Vector3().crossVectors(normal, dir).normalize();
    const tip = hv.clone().addScaledVector(dir, HEAD_LEAD);
    const base = tip.clone().addScaledVector(dir, -HEAD_LEN);
    const t = toScreen(tip.toArray());
    segs.push([pts[pts.length - 1], t]);
    head = [t, toScreen(base.clone().addScaledVector(side, HEAD_W / 2).toArray()), toScreen(base.clone().addScaledVector(side, -HEAD_W / 2).toArray())];
  }
  return { id, segs, head, tip: head ? head[0] : null };
}

function pickPath(clientX, clientY) {
  turntable.updateMatrixWorld(true);
  const cands = [];
  for (const id of pathGroups.keys()) {
    const c = tapShape(id);
    if (c && (c.segs.length || c.head)) cands.push(c);
  }
  const now = performance.now();
  const flyAge = new Map([...flyStart].map(([id, t]) => [id, now - t]));
  return pickTapInfo(clientX, clientY, cands, flyAge, HIT_RADIUS_PX);
}

// Own pointer handling (OrbitControls is not used; it is only vendored).
// One gesture per pointerId, captured on the canvas at pointerdown and released
// on pointerup / pointercancel, so moves keep coming even off the canvas and
// rapid two-finger taps are each their own tap.
// A pointer that stays within TAP_PX (8px) of where it landed is a tap; once it
// goes past 8px it is a drag for the rest of that touch: it turns the shape and
// never taps, even if it started on an arrow or comes back to its start. Taps,
// the hit test and fly-offs never block a drag.
// Drag = one-to-one follow from the touch-down point (the shape turns by the
// whole finger movement, so a short flick still turns it), every move event
// (coalesced ones too) applied, a short inertial glide on release, no snapping.
const ROT_PER_PX = 0.012;
const GLIDE_TAU_MS = 100; // glide decays with this time constant (~0.3s to rest)
const GLIDE_MAX_V = 0.3; // px/ms cap: a glide adds at most ~30px (~0.36 rad) of turn
const gestures = new Map();

const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
function rotateBy(dx, dy) {
  rotY += dx * ROT_PER_PX;
  rotX += dy * ROT_PER_PX;
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  // horizontal finger motion turns about the camera's up axis, vertical about its right axis
  if (dx) viewQ.premultiply(_q.setFromAxisAngle(_axis.set(e[4], e[5], e[6]).normalize(), dx * ROT_PER_PX));
  if (dy) viewQ.premultiply(_q.setFromAxisAngle(_axis.set(e[0], e[1], e[2]).normalize(), dy * ROT_PER_PX));
  viewQ.normalize();
  applyRot();
}

function dropStaleGestures() {
  // Nothing may get stuck: a gesture whose pointer lost capture without an
  // up/cancel (e.g. the browser took the touch) is forgotten.
  for (const id of [...gestures.keys()]) {
    let live = false;
    try {
      live = renderer.domElement.hasPointerCapture(id);
    } catch {}
    if (!live) gestures.delete(id);
  }
}

const canvasEl = renderer.domElement;
canvasEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  glide = null;
  dropStaleGestures();
  gestures.delete(e.pointerId);
  try {
    canvasEl.setPointerCapture(e.pointerId);
  } catch {}
  gestures.set(e.pointerId, { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false, samples: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] });
});

canvasEl.addEventListener("pointermove", (e) => {
  const g = gestures.get(e.pointerId);
  if (!g) return;
  const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const x = ev.clientX, y = ev.clientY;
    g.samples.push({ x, y, t: ev.timeStamp || e.timeStamp });
    if (g.samples.length > 12) g.samples.shift();
    if (!g.dragging) {
      if (Math.hypot(x - g.x, y - g.y) <= TAP_PX) continue;
      g.dragging = true; // from here on it is a drag, never a tap
    }
    rotateBy(x - g.lastX, y - g.lastY);
    g.lastX = x;
    g.lastY = y;
  }
});

function releaseCapture(id) {
  try {
    if (canvasEl.hasPointerCapture(id)) canvasEl.releasePointerCapture(id);
  } catch {}
}

function endGesture(e, allowTap) {
  const g = gestures.get(e.pointerId);
  gestures.delete(e.pointerId);
  releaseCapture(e.pointerId);
  if (!g) return;
  if (g.dragging) {
    if (!allowTap) return;
    // Glide on from the release velocity (last ~60ms of movement), if the finger
    // was still moving when it lifted.
    const last = g.samples[g.samples.length - 1];
    const first = g.samples.find((p) => last.t - p.t <= 60) || last;
    const dt = last.t - first.t;
    if (dt > 0 && e.timeStamp - last.t < 50) {
      const clamp = (v) => Math.max(-GLIDE_MAX_V, Math.min(GLIDE_MAX_V, v));
      glide = { vx: clamp((last.x - first.x) / dt), vy: clamp((last.y - first.y) / dt), t: performance.now() };
    }
    return;
  }
  if (!allowTap) return;
  if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > TAP_PX) return;
  // Judge the tap where the finger landed (jitter before lifting doesn't move it).
  const pick = pickPath(g.x, g.y);
  trySend(pick.id, pick.guarded);
}

function stepGlide(now) {
  if (!glide) return;
  const dt = Math.min(50, now - glide.t);
  glide.t = now;
  const k = Math.exp(-dt / GLIDE_TAU_MS);
  // distance covered this frame by an exponentially decaying velocity
  const f = GLIDE_TAU_MS * (1 - k);
  rotateBy(glide.vx * f, glide.vy * f);
  glide.vx *= k;
  glide.vy *= k;
  if (Math.hypot(glide.vx, glide.vy) < 0.01) glide = null;
}

canvasEl.addEventListener("pointerup", (e) => endGesture(e, true));
canvasEl.addEventListener("pointercancel", (e) => endGesture(e, false));
canvasEl.addEventListener("lostpointercapture", (e) => {
  // After pointerup the gesture is already gone; otherwise the browser took the
  // pointer away: end it as a cancel so no drag state is left behind.
  if (gestures.has(e.pointerId)) endGesture(e, false);
});

new ResizeObserver(() => fitCamera()).observe(viewEl);

function faceTowardCamera(normal, point) {
  const n = normal.clone().transformDirection(content.matrixWorld).normalize();
  const p = point.clone();
  content.localToWorld(p);
  const toCam = camera.position.clone().sub(p).normalize();
  // Any face turned toward the eye gets full ink, even at a grazing angle (the
  // old 0.2 cut-off ghosted the cross's left-arm side face at ~0.20). Ink is
  // FrontSide, so only exactly edge-on and back faces (<= NEAR_DOT) stay faint.
  return n.dot(toCam) > NEAR_DOT;
}

function orientDraws() {
  // Always keep paper on every face. Hiding far glass opened the shell so
  // DoubleSide near ink undersides read as solid-black "far" paths.
  turntable.updateMatrixWorld(true);
  for (const g of glassFaces) {
    g.mesh.visible = true;
    g.backing.visible = true;
    g.backing.renderOrder = 1;
    g.mesh.renderOrder = 2;
  }
  for (const child of content.children) {
    // A path group may carry a tap tint (blue slide / red shake); else black.
    const ink = child.userData.inkMat || black;
    child.traverse((obj) => {
      if (!obj.isMesh || !obj.userData.faceNormal) return;
      const near = faceTowardCamera(obj.userData.faceNormal, obj.userData.facePoint);
      // Near = solid tappable ink. Far = faint ghost seen through the glass (never looks tappable).
      obj.visible = true;
      obj.material = inkFor(obj, near, ink);
      obj.renderOrder = obj.userData.air ? AIR_ORDER : near ? (obj.userData.kind === "arrow" ? 5 : 4) : 3;
    });
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  stepGlide(now);
  for (let i = anims.length - 1; i >= 0; i--) {
    if (anims[i](now)) anims.splice(i, 1);
  }
  orientDraws();
  renderer.render(scene, camera);
}

// Local review only: ?review=1 lets the headless play-through find tappable arrows.
if (new URLSearchParams(location.search).get("review") === "1") {
  window.__falconReview = {
    state: () => ({ roundIndex: state.roundIndex, alive: state.alive.slice(), pips: state.pips, won: state.won, busy: inFlight > 0 || pendingBuild, inFlight, pendingBuild, flying: [...flying],
      count: countEl ? countEl.textContent : null, pipsDom: document.querySelectorAll("#pips .pip.on").length,
      pipsAtTop: !!document.querySelector("#top #pips") }),
    tapLog: () => tapLog.slice(),
    // Exit geometry of a resting arrow: is the path past the head straight and in
    // its face plane, is the head at its edge, and the screen polygon / visibility
    // of the neighbouring face across the exit edge.
    exitInfo(id) {
      const rec = pathGroups.get(id);
      if (!rec) return null;
      turntable.updateMatrixWorld(true);
      const R = rec.route;
      const hi = rec.body.pts.length - 1;
      const h = R.pts[hi];
      const n = R.nrm[R.nrm.length - 1];
      const e = R.pts[R.pts.length - 2];
      const f = R.pts[R.pts.length - 1];
      const dl = Math.hypot(f[0] - e[0], f[1] - e[1], f[2] - e[2]);
      const d = [(f[0] - e[0]) / dl, (f[1] - e[1]) / dl, (f[2] - e[2]) / dl];
      let maxNormal = 0, maxSide = 0;
      for (let i = hi; i < R.pts.length; i++) {
        const v = [R.pts[i][0] - h[0], R.pts[i][1] - h[1], R.pts[i][2] - h[2]];
        maxNormal = Math.max(maxNormal, Math.abs(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]));
        const c = [v[1] * d[2] - v[2] * d[1], v[2] * d[0] - v[0] * d[2], v[0] * d[1] - v[1] * d[0]];
        maxSide = Math.max(maxSide, Math.hypot(c[0], c[1], c[2]));
        if (i > hi) maxNormal = Math.max(maxNormal, Math.abs(R.nrm[i - 1][0] - n[0]) + Math.abs(R.nrm[i - 1][1] - n[1]) + Math.abs(R.nrm[i - 1][2] - n[2]));
      }
      const ax = d.findIndex((x) => Math.abs(x) > 0.5);
      let neighbour = null;
      for (const face of roundFaces) {
        if (face.axis !== ax || face.sign !== Math.sign(d[ax]) || Math.abs(face.value - e[ax]) > 1e-6) continue;
        const [u0, v0, u1, v1] = face.rects[0];
        const eu = e[face.uAxis], ev = e[face.vAxis];
        if (eu < u0 - 1e-6 || eu > u1 + 1e-6 || ev < v0 - 1e-6 || ev > v1 + 1e-6) continue;
        const poly = faceCorners(face, face.value, u0, u1, v0, v1).map(toScreen);
        const visible = faceTowardCamera(new THREE.Vector3(...face.normal), new THREE.Vector3(...face.point));
        neighbour = { poly, visible };
      }
      const own = roundFaces.find((face) => face.normal[0] === n[0] && face.normal[1] === n[1] && face.normal[2] === n[2] && Math.abs(face.value - h[face.axis]) < 1e-6 && (() => { const [u0, v0, u1, v1] = face.rects[0]; return h[face.uAxis] > u0 && h[face.uAxis] < u1 && h[face.vAxis] > v0 && h[face.vAxis] < v1; })());
      return {
        straightInPlane: maxNormal < 1e-9 && maxSide < 1e-9,
        maxNormal, maxSide,
        headAtEdge: R.edgeAt - (rec.bodyLen + HEAD_LEAD) < 1,
        cellsAhead: Math.round(R.edgeAt - 0.5 - rec.bodyLen),
        bodyLen: rec.bodyLen,
        neighbour,
        // screen points at the edge, 1 and 2 cells past it, on the exit line (lifted like the ink)
        marks: [0, 1, 2].map((k) => toScreen([e[0] + d[0] * k + n[0] * LIFT, e[1] + d[1] * k + n[1] * LIFT, e[2] + d[2] * k + n[2] * LIFT])),
        ownPoly: own ? faceCorners(own, own.value, own.rects[0][0], own.rects[0][2], own.rects[0][1], own.rects[0][3]).map(toScreen) : null,
      };
    },
    rot: () => ({ x: rotX, y: rotY, q: turntable.quaternion.toArray(), gliding: !!glide, gestures: gestures.size }),
    // Screen point just behind the arrowhead tip (inside the head), or null.
    headTap(id) {
      turntable.updateMatrixWorld(true);
      const c = tapShape(id);
      if (!c || !c.head) return null;
      const [t, b1, b2] = c.head;
      return { x: t.x * 0.6 + (b1.x + b2.x) * 0.2, y: t.y * 0.6 + (b1.y + b2.y) * 0.2 };
    },
    // Screen point of the middle of an arrow's longest near-facing segment, or null.
    tapPoint(id) {
      const rec = pathGroups.get(id);
      if (!rec) return null;
      turntable.updateMatrixWorld(true);
      let best = null;
      const line = rec.body;
      for (let i = 1; i < line.pts.length; i++) {
        const n = line.nrm[i - 1];
        const mid = lerp3(line.pts[i - 1], line.pts[i], 0.5);
        if (!faceTowardCamera(new THREE.Vector3(n[0], n[1], n[2]), new THREE.Vector3(mid[0], mid[1], mid[2]))) continue;
        const sp = toScreen(mid);
        if (pickPath(sp.x, sp.y).id !== id) continue;
        best = sp;
        break;
      }
      return best;
    },
  };
}

try {
  buildRound();
} catch (err) {
  document.title = "ERR " + (err && err.stack ? err.stack : err);
}
updateHud();
requestAnimationFrame(frame);
