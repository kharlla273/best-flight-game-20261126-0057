// The renderer: a chase-view 3D flight scene painted on one 2D canvas, plus the full HUD and
// the title / pause / end screens. No images, no fonts from the network — every pixel is
// drawn from the world state, so a screenshot is always the game itself.
import {
  FIELD_GOLD, GRASS_HIGH, GRASS_LOW, HUD_AMBER, HUD_GREEN, HUD_RED, RINGS,
  ROCK, ROAD, RUNWAY, RUNWAY_COLOR, RUNWAY_ELEV, SKY_HORIZON, SKY_TOP,
  SNOW, SPEED_MAX, SUN_COLOR, VIEW_DISTANCE, WATER, WATER_LEVEL,
} from './config.js';
import { fieldPatch, groundHeight, groundSlope, isWater, onRunway, riverDistance, ROADS, TOWN } from './terrain.js';
import { noise2 } from './random.js';
import { objectiveBearing, PHASE_DONE, PHASE_LAND, PHASE_RINGS, ringDistance } from './missions.js';

const TAU = Math.PI * 2;
const FT_PER_M = 3.28084;

// Cloud positions, fixed in the world so they never jump between frames.
const CLOUDS = [];
{
  let s = 987654;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 16; i += 1) {
    CLOUDS.push({
      x: -1400 + rnd() * 3400,
      z: -1500 + rnd() * 3000,
      y: 420 + rnd() * 180,
      s: 90 + rnd() * 130,
    });
  }
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // --- camera ---------------------------------------------------------------
  // The camera sits behind and above the plane, banks with it a little, and looks
  // slightly down the nose. Basis vectors are rebuilt every frame from the plane.
  function cameraBasis(plane) {
    const viewPitch = plane.pitch * 0.7 - 0.05;
    const fwd = {
      x: Math.cos(plane.heading) * Math.cos(viewPitch),
      y: Math.sin(viewPitch),
      z: -Math.sin(plane.heading) * Math.cos(viewPitch),
    };
    const bank = plane.roll * 0.45;
    // World-up rotated by the bank around the view axis.
    const upRaw = { x: 0, y: 1, z: 0 };
    const right = norm(cross(fwd, upRaw));
    let up = norm(cross(right, fwd));
    // Roll the up vector around fwd by `bank`.
    const cosB = Math.cos(bank);
    const sinB = Math.sin(bank);
    up = {
      x: up.x * cosB + right.x * sinB,
      y: up.y * cosB + right.y * sinB,
      z: up.z * cosB + right.z * sinB,
    };
    const right2 = norm(cross(fwd, up));
    const cam = {
      x: plane.x - fwd.x * 11,
      y: plane.y - fwd.y * 11 + 3.2,
      z: plane.z - fwd.z * 11,
    };
    return { fwd, right: right2, up, cam };
  }

  function cross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }

  function norm(v) {
    const len = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  }

  function makeProjector(basis) {
    const focal = height * 1.05;
    const cx = width / 2;
    const cy = height * 0.52;
    return function project(x, y, z) {
      const dx = x - basis.cam.x;
      const dy = y - basis.cam.y;
      const dz = z - basis.cam.z;
      const depth = dx * basis.fwd.x + dy * basis.fwd.y + dz * basis.fwd.z;
      if (depth < 3) return null;
      const px = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
      const py = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;
      return { x: cx + (px / depth) * focal, y: cy - (py / depth) * focal, d: depth };
    };
  }

  // A projector for ground geometry that clamps points just in front of the near plane
  // onto it instead of dropping them: the strip right under the camera still paints,
  // so the bottom of the screen is ground, never a hole showing the sky gradient.
  function makeClampedProjector(basis) {
    const focal = height * 1.05;
    const cx = width / 2;
    const cy = height * 0.52;
    return function projectClamped(x, y, z) {
      const dx = x - basis.cam.x;
      const dy = y - basis.cam.y;
      const dz = z - basis.cam.z;
      const depth = dx * basis.fwd.x + dy * basis.fwd.y + dz * basis.fwd.z;
      if (depth <= 0.5) return null;
      const clamped = Math.max(depth, 2);
      const px = dx * basis.right.x + dy * basis.right.y + dz * basis.right.z;
      const py = dx * basis.up.x + dy * basis.up.y + dz * basis.up.z;
      return { x: cx + (px / clamped) * focal, y: cy - (py / clamped) * focal, d: depth };
    };
  }

  // --- sky ------------------------------------------------------------------
  function drawSky(basis, plane, time) {
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, SKY_TOP);
    grad.addColorStop(0.55, SKY_HORIZON);
    grad.addColorStop(1, '#dfe9e2');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Sun: fixed in the north-east sky, high enough to light the instruments.
    const sunDir = norm({ x: 0.55, y: 0.62, z: -0.55 });
    const sunAt = {
      x: basis.cam.x + sunDir.x * 4000,
      y: basis.cam.y + sunDir.y * 4000,
      z: basis.cam.z + sunDir.z * 4000,
    };
    const project = makeProjector(basis);
    const s = project(sunAt.x, sunAt.y, sunAt.z);
    if (s) {
      const glow = ctx.createRadialGradient(s.x, s.y, 4, s.x, s.y, 120);
      glow.addColorStop(0, 'rgba(255, 243, 196, 0.95)');
      glow.addColorStop(0.25, 'rgba(255, 236, 170, 0.55)');
      glow.addColorStop(1, 'rgba(255, 236, 170, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 120, 0, TAU);
      ctx.fill();
      ctx.fillStyle = SUN_COLOR;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 22, 0, TAU);
      ctx.fill();
    }

    // Distant ridges: a hazy silhouette strip along the horizon, shaped by the heading.
    const horizon = project(basis.cam.x + basis.fwd.x * 5000, basis.cam.y, basis.cam.z + basis.fwd.z);
    const hy = horizon ? horizon.y : height * 0.52;
    ctx.fillStyle = 'rgba(122, 148, 178, 0.55)';
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let sx = 0; sx <= width; sx += 24) {
      const n = noise2(sx * 0.004 + plane.heading * 2.2, 3.7, 5);
      const peak = 60 + n * 90;
      ctx.lineTo(sx, hy - peak);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(140, 165, 190, 0.35)';
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let sx = 0; sx <= width; sx += 24) {
      const n = noise2(sx * 0.006 + plane.heading * 3.1 + 40, 9.2, 5);
      ctx.lineTo(sx, hy - 20 - n * 45);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  }

  // --- terrain --------------------------------------------------------------
  function terrainColor(x, z, h, slope) {
    if (isWater(x, z)) return WATER;
    const patch = fieldPatch(x, z);
    let base;
    if (patch === 0) base = FIELD_GOLD;
    else if (patch === 1) base = '#4a7a33';
    else if (h > 250) base = SNOW;
    else if (h > 170) base = ROCK;
    else {
      const t = Math.max(0, Math.min(1, (h - RUNWAY_ELEV) / 120));
      base = lerpColor(GRASS_LOW, GRASS_HIGH, t);
    }
    // Slope shading + a little grain so flat grass is not a dead slab.
    const shade = 1 - Math.min(0.35, slope * 0.5);
    const grain = 0.94 + 0.06 * noise2(x * 0.08, z * 0.08, 11);
    return shadeColor(base, shade * grain);
  }

  function drawTerrain(basis, plane) {
    const project = makeClampedProjector(basis);
    const fx = Math.cos(plane.heading);
    const fz = -Math.sin(plane.heading);
    const rx = -fz;
    const rz = fx;
    const step = 45;
    const rows = Math.ceil((VIEW_DISTANCE + 60) / step);
    const halfWidth = 1100;
    // Far rows first so near ground paints over far ground. Rows start just behind the
    // camera so the ground right under the nose is drawn too.
    for (let row = rows; row >= 0; row -= 1) {
      const d0 = -60 + row * step;
      const d1 = d0 + step;
      for (let lat = -halfWidth; lat < halfWidth; lat += step) {
        const corners = [];
        let visible = false;
        for (const [d, l] of [[d0, lat], [d1, lat], [d1, lat + step], [d0, lat + step]]) {
          const wx = plane.x + fx * d + rx * l;
          const wz = plane.z + fz * d + rz * l;
          const wy = groundHeight(wx, wz);
          const p = project(wx, wy, wz);
          corners.push(p);
          if (p) visible = true;
        }
        if (!visible) continue;
        // Skip quads that straddle the camera (one corner behind it).
        if (corners.some((c) => c === null)) continue;
        const cxw = plane.x + fx * (d0 + step / 2) + rx * (lat + step / 2);
        const czw = plane.z + fz * (d0 + step / 2) + rz * (lat + step / 2);
        const h = groundHeight(cxw, czw);
        const slope = groundSlope(cxw, czw);
        ctx.fillStyle = terrainColor(cxw, czw, h, slope);
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 4; i += 1) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  function drawRoads(basis) {
    const project = makeProjector(basis);
    ctx.strokeStyle = ROAD;
    ctx.lineCap = 'round';
    for (const road of ROADS) {
      for (let i = 0; i < road.points.length - 1; i += 1) {
        const [x0, z0] = road.points[i];
        const [x1, z1] = road.points[i + 1];
        // Walk the segment in small steps so it hugs the hills.
        ctx.beginPath();
        let started = false;
        for (let t = 0; t <= 1.0001; t += 0.05) {
          const wx = x0 + (x1 - x0) * t;
          const wz = z0 + (z1 - z0) * t;
          const p = project(wx, groundHeight(wx, wz) + 0.6, wz);
          if (!p) continue;
          if (!started) {
            ctx.moveTo(p.x, p.y);
            started = true;
          } else ctx.lineTo(p.x, p.y);
        }
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }

  function drawTown(basis) {
    const project = makeProjector(basis);
    for (const house of TOWN) {
      const gy = groundHeight(house.x, house.z);
      const hw = house.w / 2;
      const hd = house.d / 2;
      const base = [
        [house.x - hw, gy, house.z - hd],
        [house.x + hw, gy, house.z - hd],
        [house.x + hw, gy, house.z + hd],
        [house.x - hw, gy, house.z + hd],
      ];
      const top = base.map(([x, , z]) => [x, gy + house.h, z]);
      const bp = base.map(([x, y, z]) => project(x, y, z));
      const tp = top.map(([x, y, z]) => project(x, y, z));
      if (bp.some((p) => !p) || tp.some((p) => !p)) continue;
      // Walls: two visible faces, roof on top.
      ctx.fillStyle = '#b8a88f';
      quad(bp[0], bp[1], tp[1], tp[0]);
      ctx.fillStyle = '#8f8271';
      quad(bp[1], bp[2], tp[2], tp[1]);
      ctx.fillStyle = '#a34d3d';
      quad(tp[0], tp[1], tp[2], tp[3]);
    }
  }

  function quad(a, b, c, d) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
    ctx.fill();
  }

  function drawRunway(basis) {
    // The strip is drawn in short segments so the part right under the camera still
    // paints when its far end is behind it; the clamped projector keeps near segments
    // on screen instead of dropping the whole strip.
    const project = makeClampedProjector(basis);
    const halfL = RUNWAY.length / 2;
    const halfW = RUNWAY.width / 2;
    const segments = 12;
    const segLen = RUNWAY.length / segments;
    ctx.fillStyle = RUNWAY_COLOR;
    for (let s = 0; s < segments; s += 1) {
      const x0 = RUNWAY.x - halfL + s * segLen;
      const x1 = x0 + segLen;
      const corners = [
        project(x0, RUNWAY_ELEV + 0.4, RUNWAY.z - halfW),
        project(x1, RUNWAY_ELEV + 0.4, RUNWAY.z - halfW),
        project(x1, RUNWAY_ELEV + 0.4, RUNWAY.z + halfW),
        project(x0, RUNWAY_ELEV + 0.4, RUNWAY.z + halfW),
      ];
      if (corners.some((p) => !p)) continue;
      quad(corners[0], corners[1], corners[2], corners[3]);
    }
    // Centreline dashes.
    ctx.fillStyle = '#e8e8e8';
    for (let x = -halfL + 30; x < halfL - 20; x += 40) {
      const a = project(x, RUNWAY_ELEV + 0.7, RUNWAY.z - 1.2);
      const b = project(x + 18, RUNWAY_ELEV + 0.7, RUNWAY.z - 1.2);
      const c = project(x + 18, RUNWAY_ELEV + 0.7, RUNWAY.z + 1.2);
      const d = project(x, RUNWAY_ELEV + 0.7, RUNWAY.z + 1.2);
      if (a && b && c && d) quad(a, b, c, d);
    }
    // Threshold chevrons at both ends.
    for (const end of [-1, 1]) {
      const tx = end * (halfL - 12);
      const a = project(tx - 8 * end, RUNWAY_ELEV + 0.7, RUNWAY.z - halfW + 3);
      const b = project(tx + 8 * end, RUNWAY_ELEV + 0.7, RUNWAY.z - halfW + 3);
      const c = project(tx + 8 * end, RUNWAY_ELEV + 0.7, RUNWAY.z + halfW - 3);
      const d = project(tx - 8 * end, RUNWAY_ELEV + 0.7, RUNWAY.z + halfW - 3);
      if (a && b && c && d) {
        ctx.fillStyle = '#f2f2f2';
        quad(a, b, c, d);
      }
    }
    // Edge lights: small amber dots along both edges.
    ctx.fillStyle = HUD_AMBER;
    for (let x = -halfL; x <= halfL; x += 62) {
      for (const edge of [-halfW + 1.5, halfW - 1.5]) {
        const p = project(x, RUNWAY_ELEV + 1.2, RUNWAY.z + edge);
        if (p && p.d < 1600) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1.5, 260 / p.d), 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  // --- rings ----------------------------------------------------------------
  // Each ring faces the pilot flying in from the previous ring, so the hole reads as a
  // target from the approach line, not as a flat hoop seen edge-on.
  function ringNormal(index) {
    const ring = RINGS[index];
    const prev = index === 0 ? { x: -260, z: 0 } : RINGS[index - 1];
    const dx = ring.x - prev.x;
    const dz = ring.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  function drawRings(basis, mission, time) {
    const project = makeProjector(basis);
    for (let i = 0; i < RINGS.length; i += 1) {
      const ring = RINGS[i];
      const passed = i < mission.ringIndex;
      const next = i === mission.ringIndex && mission.phase === PHASE_RINGS;
      if (!next && !passed && i > mission.ringIndex + 1) continue; // only near rings matter
      const n = ringNormal(i);
      // In-plane axes: horizontal across the approach, and vertical.
      const ax = { x: -n.z, y: 0, z: n.x };
      const ay = { x: 0, y: 1, z: 0 };
      const pulse = next ? 1 + 0.08 * Math.sin(time * 4) : 1;
      const r = ring.r * pulse;
      const pts = [];
      for (let k = 0; k <= 28; k += 1) {
        const a = (k / 28) * TAU;
        const wx = ring.x + (ax.x * Math.cos(a) + ay.x * Math.sin(a)) * r;
        const wy = ring.y + (ax.y * Math.cos(a) + ay.y * Math.sin(a)) * r;
        const wz = ring.z + (ax.z * Math.cos(a) + ay.z * Math.sin(a)) * r;
        pts.push(project(wx, wy, wz));
      }
      const color = passed ? '#3ddc78' : next ? HUD_AMBER : 'rgba(255,255,255,0.75)';
      ctx.strokeStyle = color;
      ctx.lineWidth = next ? 5 : 3;
      ctx.shadowColor = color;
      ctx.shadowBlur = next ? 18 : 0;
      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (!p) continue;
        if (!started) {
          ctx.moveTo(p.x, p.y);
          started = true;
        } else ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Number plate above the next ring so the pilot knows which one it is.
      if (next) {
        const top = project(ring.x, ring.y + r + 14, ring.z);
        if (top) {
          ctx.fillStyle = HUD_AMBER;
          ctx.font = `bold ${Math.max(13, 900 / Math.max(60, top.d))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(`RING ${i + 1}`, top.x, top.y);
        }
      }
    }
  }

  // --- clouds ---------------------------------------------------------------
  function drawClouds(basis) {
    const project = makeProjector(basis);
    const sorted = [...CLOUDS].sort((a, b) => {
      const da = Math.hypot(a.x - basis.cam.x, a.z - basis.cam.z);
      const db = Math.hypot(b.x - basis.cam.x, b.z - basis.cam.z);
      return db - da;
    });
    ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
    for (const cloud of sorted) {
      const p = project(cloud.x, cloud.y, cloud.z);
      if (!p || p.d > 3200) continue;
      const scale = (900 / p.d) * (cloud.s / 100);
      if (scale < 0.08) continue;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 62 * scale, 18 * scale, 0, 0, TAU);
      ctx.ellipse(p.x - 34 * scale, p.y + 6 * scale, 38 * scale, 13 * scale, 0, 0, TAU);
      ctx.ellipse(p.x + 36 * scale, p.y + 5 * scale, 40 * scale, 14 * scale, 0, 0, TAU);
      ctx.fill();
    }
  }

  // --- the aircraft ---------------------------------------------------------
  // Chase view: the courier herself, drawn from behind and above, banking with the roll.
  // She is a high-wing bush plane in courier yellow with a teal stripe — drawn, not traced.
  function drawPlane(plane, time) {
    const px = width / 2;
    const py = height * 0.60;
    const scale = Math.min(width, height) / 620;

    // Soft shadow on the ground below, when the ground is close enough to read.
    const groundY = groundHeight(plane.x, plane.z);
    const agl = plane.y - groundY;
    if (agl < 260 && plane.airborne) {
      const basis = cameraBasis(plane);
      const project = makeProjector(basis);
      const sp = project(plane.x, groundY + 1, plane.z);
      if (sp) {
        const size = Math.max(8, 5200 / Math.max(40, agl + 30));
        ctx.fillStyle = `rgba(20, 30, 20, ${Math.max(0.05, 0.30 - agl / 900)})`;
        ctx.beginPath();
        ctx.ellipse(sp.x, sp.y, size, size * 0.28, 0, 0, TAU);
        ctx.fill();
      }
    }

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-plane.roll * 0.85);
    ctx.scale(scale, scale);

    // Tailplane and fin (behind the wing from this view, drawn first).
    ctx.fillStyle = '#e8a13a';
    ctx.beginPath();
    ctx.moveTo(-58, -6);
    ctx.lineTo(-30, -14);
    ctx.lineTo(-28, -2);
    ctx.lineTo(-58, 2);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(58, -6);
    ctx.lineTo(30, -14);
    ctx.lineTo(28, -2);
    ctx.lineTo(58, 2);
    ctx.closePath();
    ctx.fill();
    // Vertical fin.
    ctx.fillStyle = '#d18a1f';
    ctx.beginPath();
    ctx.moveTo(-4, -10);
    ctx.lineTo(4, -10);
    ctx.lineTo(10, -34);
    ctx.lineTo(-2, -38);
    ctx.closePath();
    ctx.fill();

    // Main wing: high wing, slight dihedral, yellow with teal tips.
    ctx.fillStyle = '#f2b63c';
    ctx.beginPath();
    ctx.moveTo(-150, 6);
    ctx.lineTo(-24, -4);
    ctx.lineTo(24, -4);
    ctx.lineTo(150, 6);
    ctx.lineTo(146, 16);
    ctx.lineTo(-146, 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1f7a6d';
    ctx.beginPath();
    ctx.moveTo(-150, 6);
    ctx.lineTo(-128, 4);
    ctx.lineTo(-126, 15);
    ctx.lineTo(-146, 16);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(150, 6);
    ctx.lineTo(128, 4);
    ctx.lineTo(126, 15);
    ctx.lineTo(146, 16);
    ctx.closePath();
    ctx.fill();

    // Fuselage: rounded, seen from behind, with the teal cheatline.
    ctx.fillStyle = '#f7c95c';
    ctx.beginPath();
    ctx.ellipse(0, 2, 26, 30, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#1f7a6d';
    ctx.beginPath();
    ctx.ellipse(0, 10, 26, 12, 0, 0, Math.PI);
    ctx.fill();
    // Rear window glow and tail cone.
    ctx.fillStyle = '#274b63';
    ctx.beginPath();
    ctx.ellipse(0, -6, 14, 10, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#f7c95c';
    ctx.beginPath();
    ctx.moveTo(-10, -26);
    ctx.lineTo(10, -26);
    ctx.lineTo(6, -40);
    ctx.lineTo(-6, -40);
    ctx.closePath();
    ctx.fill();

    // Navigation lights: red left, green right, white strobe blinking on the tail.
    ctx.fillStyle = '#ff4d3d';
    ctx.beginPath();
    ctx.arc(-148, 10, 4, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#39e585';
    ctx.beginPath();
    ctx.arc(148, 10, 4, 0, TAU);
    ctx.fill();
    if (Math.floor(time * 1.6) % 2 === 0) {
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(0, -40, 3.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    // Prop wash shimmer under the wing when the engine is working.
    if (plane.throttle > 0.15) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + 0.05 * plane.throttle})`;
      ctx.beginPath();
      ctx.ellipse(0, 26, 30, 8 + 6 * Math.sin(time * 31), 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- HUD ------------------------------------------------------------------
  function drawHud(plane, mission, now, time, screen) {
    if (screen !== 'play') return;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Heading tape, top centre.
    const tapeW = Math.min(420, width * 0.42);
    const tapeX = width / 2 - tapeW / 2;
    const tapeY = 18;
    ctx.fillStyle = 'rgba(10, 22, 34, 0.55)';
    roundRect(tapeX, tapeY, tapeW, 34, 6);
    ctx.fill();
    const headingDeg = ((plane.heading * 180) / Math.PI % 360 + 360) % 360;
    const pxPerDeg = tapeW / 90;
    ctx.save();
    ctx.beginPath();
    ctx.rect(tapeX, tapeY, tapeW, 34);
    ctx.clip();
    for (let d = -60; d <= 60; d += 5) {
      const deg = Math.round((headingDeg + d) / 5) * 5;
      const x = width / 2 + (deg - headingDeg) * pxPerDeg;
      const norm = ((deg % 360) + 360) % 360;
      const major = norm % 30 === 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath();
      ctx.moveTo(x, tapeY + 34);
      ctx.lineTo(x, tapeY + (major ? 18 : 26));
      ctx.stroke();
      if (major) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        // Heading 0 is east, 90 is north, 180 is west, 270 is south.
        const label = norm === 0 ? 'E' : norm === 90 ? 'N' : norm === 180 ? 'W' : norm === 270 ? 'S' : String(norm);
        ctx.fillText(label, x, tapeY + 15);
      }
    }
    ctx.restore();
    ctx.fillStyle = HUD_AMBER;
    ctx.beginPath();
    ctx.moveTo(width / 2 - 7, tapeY + 34);
    ctx.lineTo(width / 2 + 7, tapeY + 34);
    ctx.lineTo(width / 2, tapeY + 44);
    ctx.closePath();
    ctx.fill();

    // Speed (left) and altitude (right): big lit digits with tapes.
    drawGauge(16, 66, 'SPD', `${Math.round(plane.speed)}`, 'KT', plane.speed / SPEED_MAX, plane.stalled ? HUD_RED : HUD_GREEN);
    const altFt = Math.round(plane.y * FT_PER_M);
    const aglFt = Math.round((plane.y - groundHeight(plane.x, plane.z)) * FT_PER_M);
    drawGauge(width - 176, 66, 'ALT', `${altFt}`, `FT · AGL ${aglFt}`, Math.min(1, plane.y / 600), HUD_GREEN);

    // Artificial horizon, bottom left.
    drawAttitude(plane);

    // Fuel, hull and throttle bars, bottom right.
    const bx = width - 216;
    const by = height - 128;
    drawBar(bx, by, 200, 'FUEL', plane.fuel / 100, plane.fuel < 20 ? HUD_RED : HUD_GREEN, `${Math.round(plane.fuel)}%`);
    drawBar(bx, by + 34, 200, 'HULL', plane.hull / 100, plane.hull < 30 ? HUD_RED : HUD_GREEN, `${Math.round(plane.hull)}%`);
    drawBar(bx, by + 68, 200, 'THR', plane.throttle, HUD_AMBER, `${Math.round(plane.throttle * 100)}%`);
    if (plane.throttle > 0.85) {
      ctx.fillStyle = HUD_AMBER;
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText('FULL POWER', bx, by + 96);
    }

    // Objective: ring counter and distance, plus an edge arrow when it is off-screen.
    const objText = mission.phase === PHASE_RINGS
      ? `RING ${mission.ringIndex + 1}/${RINGS.length} · ${Math.round(ringDistance(plane, mission))} m`
      : mission.phase === PHASE_LAND
        ? `LAND — RUNWAY 27 · ${Math.round(Math.hypot(plane.x, plane.z))} m`
        : `SCORE ${mission.score}`;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(objText, width / 2, tapeY + 66);
    if (mission.phase !== PHASE_DONE) {
      const bearing = objectiveBearing(plane, mission);
      const absBearing = Math.abs(bearing);
      if (absBearing > 0.5) {
        const ax = width / 2 + Math.sin(bearing) * (width * 0.36);
        const ay = height * 0.42;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(bearing);
        ctx.fillStyle = HUD_AMBER;
        ctx.beginPath();
        ctx.moveTo(0, -16);
        ctx.lineTo(12, 10);
        ctx.lineTo(-12, 10);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = HUD_AMBER;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(bearing > 0 ? '◀ TURN LEFT' : 'TURN RIGHT ▶', ax, ay + 34);
      }
    }

    // Stall and low-fuel warnings.
    if (plane.stalled && Math.floor(time * 3) % 2 === 0) {
      ctx.fillStyle = HUD_RED;
      ctx.font = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('STALL — NOSE DOWN, POWER UP', width / 2, height * 0.30);
    }
    if (plane.fuel < 20 && plane.fuel > 0 && Math.floor(time * 2) % 2 === 0) {
      ctx.fillStyle = HUD_RED;
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('LOW FUEL', width / 2, height * 0.30 + 28);
    }

    // Centre flight-path marker.
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(width / 2, height * 0.52, 10, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(width / 2 - 16, height * 0.52);
    ctx.lineTo(width / 2 - 6, height * 0.52);
    ctx.moveTo(width / 2 + 6, height * 0.52);
    ctx.lineTo(width / 2 + 16, height * 0.52);
    ctx.moveTo(width / 2, height * 0.52 - 16);
    ctx.lineTo(width / 2, height * 0.52 - 6);
    ctx.stroke();

    // Score, top left under the speed gauge.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`SCORE ${mission.score}`, 18, 152);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`TIME ${formatTime(mission.elapsed)}`, 18, 170);

    // Banner and message.
    if (mission.banner && now < mission.bannerUntil) {
      ctx.fillStyle = 'rgba(10, 22, 34, 0.6)';
      const bw = Math.min(560, width * 0.7);
      roundRect(width / 2 - bw / 2, 96, bw, 36, 6);
      ctx.fill();
      ctx.fillStyle = HUD_AMBER;
      ctx.font = 'bold 17px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(mission.banner, width / 2, 119);
    }
    if (mission.message && now < mission.messageUntil) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(mission.message, width / 2, height * 0.66);
    }
  }

  function drawGauge(x, y, label, value, unit, frac, color) {
    ctx.fillStyle = 'rgba(10, 22, 34, 0.55)';
    roundRect(x, y, 160, 64, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 10, y + 16);
    ctx.fillStyle = color;
    ctx.font = 'bold 28px monospace';
    ctx.fillText(value, x + 10, y + 44);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '11px sans-serif';
    ctx.fillText(unit, x + 10, y + 58);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(x + 118, y + 12, 30, 40);
    ctx.fillStyle = color;
    const h = 40 * Math.max(0, Math.min(1, frac));
    ctx.fillRect(x + 118, y + 12 + (40 - h), 30, h);
  }

  function drawBar(x, y, w, label, frac, color, text) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, x, y + 11);
    ctx.fillStyle = 'rgba(10, 22, 34, 0.55)';
    roundRect(x + 44, y, w - 44, 14, 4);
    ctx.fill();
    ctx.fillStyle = color;
    const inner = Math.max(0, Math.min(1, frac)) * (w - 48);
    if (inner > 0) {
      roundRect(x + 46, y + 2, inner, 10, 3);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(text, x + w + 2, y + 11);
    ctx.textAlign = 'left';
  }

  function drawAttitude(plane) {
    // Position: bottom-left corner cluster.
    const cx = 92;
    const cy = height - 92;
    const r = 56;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(-plane.roll);
    const pitchPx = plane.pitch * r * 1.4;
    ctx.fillStyle = '#3f8fd2';
    ctx.fillRect(-r, -r - pitchPx, r * 2, r + pitchPx);
    ctx.fillStyle = '#8a6b46';
    ctx.fillRect(-r, -pitchPx, r * 2, r + pitchPx);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r, -pitchPx);
    ctx.lineTo(r, -pitchPx);
    ctx.stroke();
    for (const deg of [-20, -10, 10, 20]) {
      const yy = -pitchPx - Math.tan((deg * Math.PI) / 180) * r * 1.4;
      ctx.beginPath();
      ctx.moveTo(-18, yy);
      ctx.lineTo(18, yy);
      ctx.stroke();
    }
    ctx.restore();
    // Fixed aircraft symbol and rim.
    ctx.strokeStyle = HUD_AMBER;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy);
    ctx.lineTo(cx + 20, cy);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 8);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('ATTITUDE', cx, cy + r + 14);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- screens --------------------------------------------------------------
  function drawTitle(best) {
    ctx.fillStyle = 'rgba(8, 18, 30, 0.45)';
    ctx.fillRect(0, 0, width, height);
    const cx = width / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.min(64, width / 11)}px sans-serif`;
    ctx.fillText('SKYMARK COURIER', cx, height * 0.22);
    ctx.fillStyle = HUD_AMBER;
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('A valley, six rings, one strip of tarmac — and a tank of fuel.', cx, height * 0.22 + 36);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '16px sans-serif';
    const lines = [
      'Take off from runway 27, thread all six rings over Alderwick valley,',
      'then bring her home. Mind your speed — stall her and she drops.',
      'Fuel and hull are finite. A gentle touchdown pays best.',
      '',
      'W / S or ↑ / ↓ — pitch      A / D or ← / → — bank and turn',
      'SHIFT — throttle up      CTRL — throttle down      SPACE — flaps',
      'Mouse — steer gently      P — pause      M — sound      R — restart',
    ];
    lines.forEach((line, i) => ctx.fillText(line, cx, height * 0.38 + i * 26));
    if (best > 0) {
      ctx.fillStyle = HUD_GREEN;
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(`BEST SORTIE: ${best}`, cx, height * 0.38 + lines.length * 26 + 8);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px sans-serif';
    if (Math.floor(performance.now() / 600) % 2 === 0) {
      ctx.fillText('PRESS ENTER OR CLICK TO FLY', cx, height * 0.78);
    }
  }

  function drawPaused() {
    ctx.fillStyle = 'rgba(8, 18, 30, 0.55)';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 44px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('PAUSED', width / 2, height / 2 - 10);
    ctx.font = '17px sans-serif';
    ctx.fillText('P or click to carry on  ·  R to restart the sortie', width / 2, height / 2 + 28);
  }

  function drawEnd(breakdown, crashed) {
    ctx.fillStyle = 'rgba(8, 18, 30, 0.6)';
    ctx.fillRect(0, 0, width, height);
    const cx = width / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = crashed ? HUD_RED : HUD_GREEN;
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText(crashed ? 'AIRFRAME LOST' : 'SORTIE COMPLETE', cx, height * 0.26);
    ctx.fillStyle = '#fff';
    ctx.font = '18px sans-serif';
    const rows = [
      `Rings cleared: ${breakdown.ringsCleared} of ${breakdown.ringsTotal}  —  +${breakdown.rings}`,
      breakdown.landingQuality
        ? `Landing: ${breakdown.landingQuality === 'soft' ? 'a greaser' : 'firm, but down'}  —  +${breakdown.landing}`
        : 'Landing: never made it home  —  +0',
      `Time bonus: +${breakdown.timeBonus}`,
      `Flight time: ${formatTime(breakdown.elapsed)}`,
    ];
    rows.forEach((row, i) => ctx.fillText(row, cx, height * 0.38 + i * 30));
    ctx.fillStyle = HUD_AMBER;
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText(`TOTAL ${breakdown.total}`, cx, height * 0.38 + rows.length * 30 + 22);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px sans-serif';
    if (Math.floor(performance.now() / 600) % 2 === 0) {
      ctx.fillText('PRESS R TO FLY AGAIN', cx, height * 0.38 + rows.length * 30 + 62);
    }
  }

  // --- main entry -----------------------------------------------------------
  /**
   * Paint one frame. `screen` is 'title' | 'play' | 'paused' | 'over'; `now` is the mission
   * clock in seconds; `time` is wall-clock seconds for animation.
   */
  function draw(state) {
    const { plane, mission, screen, now, time, best, breakdown, crashed } = state;
    const basis = cameraBasis(plane);
    drawSky(basis, plane, time);
    drawTerrain(basis, plane);
    drawRoads(basis);
    drawRunway(basis);
    drawTown(basis);
    drawRings(basis, mission, time);
    drawClouds(basis);
    drawPlane(plane, time);
    drawHud(plane, mission, now, time, screen);
    if (screen === 'title') drawTitle(best);
    else if (screen === 'paused') drawPaused();
    else if (screen === 'over') drawEnd(breakdown, crashed);
  }

  return { draw, resize };
}

// --- colour helpers -----------------------------------------------------------
function lerpColor(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  return `rgb(${Math.round(pa[0] + (pb[0] - pa[0]) * t)}, ${Math.round(pa[1] + (pb[1] - pa[1]) * t)}, ${Math.round(pa[2] + (pb[2] - pa[2]) * t)})`;
}

function shadeColor(color, factor) {
  if (color.startsWith('rgb')) {
    const nums = color.match(/\d+/g).map(Number);
    return `rgb(${Math.round(nums[0] * factor)}, ${Math.round(nums[1] * factor)}, ${Math.round(nums[2] * factor)})`;
  }
  const p = parseHex(color);
  return `rgb(${Math.round(p[0] * factor)}, ${Math.round(p[1] * factor)}, ${Math.round(p[2] * factor)})`;
}

function parseHex(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
