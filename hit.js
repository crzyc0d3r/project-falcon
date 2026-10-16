// Tap target picking, pure (no DOM, no three.js) so it can be unit-tested.
// A tap selects the nearest line, measured in CSS px to its whole drawn shape:
// the polyline from tail to the arrowhead tip, plus the arrowhead triangle
// (a tap inside the head counts as distance 0). Within HIT_RADIUS_PX only,
// i.e. a touch area at least 2 * 22 = 44 px across around every line.

export const HIT_RADIUS_PX = 22;

export function distToSeg(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

export function inTriangle(px, py, [a, b, c]) {
  const s = (p, q, r) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y);
  const P = { x: px, y: py };
  const d1 = s(P, a, b);
  const d2 = s(P, b, c);
  const d3 = s(P, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// candidates: [{ id, segs: [[{x,y},{x,y}], ...], head: [{x,y} x3] | null }]
export function pickNearest(px, py, candidates, radius = HIT_RADIUS_PX) {
  let best = null;
  let bestD = radius;
  for (const c of candidates) {
    let d = Infinity;
    if (c.head && inTriangle(px, py, c.head)) d = 0;
    for (const [a, b] of c.segs) d = Math.min(d, distToSeg(px, py, a, b));
    if (c.head) for (let i = 0; i < 3; i++) d = Math.min(d, distToSeg(px, py, c.head[i], c.head[(i + 1) % 3]));
    if (d <= bestD && (best === null || d < bestD)) {
      bestD = d;
      best = c.id;
    }
  }
  return best;
}

// Tap judging, pure. Every tap is accepted the moment it lands (no queue, no
// "busy" lock): the rule change (send) applies at once, so the next tap is judged
// against the board without the line that just left, while its fly-off plays on.
//   pickedId : line picked under the finger by pickTap (below); null = no line
//   flying   : Set of ids whose fly-off is still playing (cannot be tapped again)
//   locked   : true only while the screen still shows a finished round that is
//              about to be rebuilt (advance / win / reset); nothing to tap then
// Returns { action: "fly" | "shake" | "none", result }.
export function judgeTap(state, send, pickedId, flying, locked = false) {
  if (locked || !pickedId) return { action: "none", result: null };
  if (flying && flying.has(pickedId)) return { action: "none", result: { ok: false, reason: "flying" } };
  const result = send(state, pickedId);
  if (result.ok) return { action: "fly", result };
  if (result.reason === "blocked" || result.reason === "reset") return { action: "shake", result };
  return { action: "none", result };
}

// Tap picking with flying lines. A line that is flying off is never a target:
// the nearest NON-flying line to the finger wins, so neighbours are tappable at
// once. One short guard stops a fast double-tap from passing through: for the
// first FLY_GUARD_MS of a fly-off, a tap whose nearest line (flying ones
// included) is that flying line does nothing. The guard covers only that one
// line's own hit area and only for that window.
//   flyAge: Map id -> ms since that line's fly-off started
// Returns the picked id or null.
export const FLY_GUARD_MS = 150;

export function pickTap(px, py, candidates, flyAge, radius = HIT_RADIUS_PX, guardMs = FLY_GUARD_MS) {
  return pickTapInfo(px, py, candidates, flyAge, radius, guardMs).id;
}

// Same as pickTap, plus why: { id, guarded } where guarded = the tap landed on a
// flying line inside its guard window (logged as "ignored-flying").
export function pickTapInfo(px, py, candidates, flyAge, radius = HIT_RADIUS_PX, guardMs = FLY_GUARD_MS) {
  if (flyAge && flyAge.size) {
    const nearestAll = pickNearest(px, py, candidates, radius);
    if (nearestAll !== null && flyAge.has(nearestAll) && flyAge.get(nearestAll) < guardMs) return { id: null, guarded: nearestAll };
    return { id: pickNearest(px, py, candidates.filter((c) => !flyAge.has(c.id)), radius), guarded: null };
  }
  return { id: pickNearest(px, py, candidates, radius), guarded: null };
}

// Tap log record. pips / arrows-left "after" are those of the board the tap was
// made on (what the HUD shows at the tap): a tap that clears a round shows 0 left
// with its pips unchanged; a blocked tap that resets the round shows 0 pips.
//   result: "sent" | "blocked" | "ignored-flying" | "none"
export function tapRecord(id, before, judged, state, guarded = null) {
  let result = "none";
  let pipsAfter = before.pips;
  let leftAfter = before.left;
  if (guarded) {
    result = "ignored-flying";
    id = guarded;
  } else if (judged && judged.result && judged.result.reason === "flying") {
    result = "ignored-flying";
  } else if (judged && judged.action === "fly") {
    result = "sent";
    const done = judged.result.reason === "advanced" || judged.result.reason === "won";
    leftAfter = done ? 0 : state.alive.length;
  } else if (judged && judged.action === "shake") {
    result = "blocked";
    pipsAfter = judged.result.reason === "reset" ? 0 : state.pips;
  }
  return { result, id: id || null, pipsBefore: before.pips, pipsAfter, leftBefore: before.left, leftAfter };
}

export function formatTap(r) {
  return `tap ${r.result} id=${r.id ?? "-"} pips ${r.pipsBefore}->${r.pipsAfter} left ${r.leftBefore}->${r.leftAfter}`;
}
