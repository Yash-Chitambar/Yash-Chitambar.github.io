/*
 * dotfield.js — halftone dot renderer for the site's animated scenes.
 *
 * A scene fills a cols × rows brightness buffer (one float per cell). The field
 * then draws one dot per cell: radius and color follow brightness. Scenes can
 * compute per cell (the black hole), or draw shapes into an offscreen canvas at
 * cell resolution and let the field read it back (the robots). Zero dependencies.
 *
 * Usage: <canvas data-scene="blackhole|robot-wave|robot-cube" data-cell="5"></canvas>
 */
(function () {
  "use strict";

  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // brightness 0..1 → color stops (deep navy → electric blue → ice white)
  const STOPS = [
    [0.0, [22, 30, 64]],
    [0.25, [38, 62, 150]],
    [0.5, [79, 124, 255]],
    [0.75, [160, 190, 255]],
    [1.0, [245, 248, 255]],
  ];
  const LUT = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k],
      [t1, c1] = STOPS[k + 1];
    const u = (t - t0) / (t1 - t0);
    for (let c = 0; c < 3; c++) LUT[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * u;
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // fast sine through a 4096-entry table (phase in radians)
  const SN = 4096,
    SK = SN / (Math.PI * 2);
  const SIN = new Float32Array(SN);
  for (let i = 0; i < SN; i++) SIN[i] = Math.sin((i / SN) * Math.PI * 2);
  const fsin = (x) => SIN[((x * SK) | 0) & (SN - 1)];

  /* ---------------------------------------------------------------- field */

  class Field {
    constructor(canvas, scene, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.scene = scene;
      this.cell = opts.cell || 5;
      this.bg = [9, 10, 14];
      this.cursor = { x: -1e9, y: -1e9, w: 0, in: false, nx: 0, ny: 0 };
      this.t = 0;
      this.last = performance.now();
      this.running = false;
      this.resize();
      this.bind();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (w * h * dpr * dpr > 4.2e6) dpr = Math.max(1, Math.sqrt(4.2e6 / (w * h)));
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.pw = Math.round(w * dpr);
      this.ph = Math.round(h * dpr);
      this.canvas.width = this.pw;
      this.canvas.height = this.ph;
      this.cp = this.cell * dpr; // cell size in device pixels
      this.cols = Math.max(1, Math.floor(this.pw / this.cp));
      this.rows = Math.max(1, Math.floor(this.ph / this.cp));
      this.ox = (this.pw - this.cols * this.cp) / 2;
      this.oy = (this.ph - this.rows * this.cp) / 2;
      this.buf = new Float32Array(this.cols * this.rows);
      this.out = new Float32Array(this.cols * this.rows);
      this.img = this.ctx.createImageData(this.pw, this.ph);
      this.bgData = new Uint8ClampedArray(this.pw * this.ph * 4);
      for (let i = 0; i < this.bgData.length; i += 4) {
        this.bgData[i] = this.bg[0];
        this.bgData[i + 1] = this.bg[1];
        this.bgData[i + 2] = this.bg[2];
        this.bgData[i + 3] = 255;
      }
      // antialiased dot kernels, one per radius level
      const cp = this.cp;
      this.kN = 20;
      this.kSize = Math.ceil(cp) + 2;
      this.kernels = [];
      const maxR = (cp / 2) * 0.92;
      for (let l = 0; l < this.kN; l++) {
        const rad = maxR * (0.18 + 0.82 * Math.pow((l + 1) / this.kN, 0.6));
        const k = new Float32Array(this.kSize * this.kSize);
        const mid = this.kSize / 2;
        for (let y = 0; y < this.kSize; y++)
          for (let x = 0; x < this.kSize; x++) {
            const d = Math.hypot(x + 0.5 - mid, y + 0.5 - mid);
            k[y * this.kSize + x] = clamp(rad - d + 0.5, 0, 1);
          }
        this.kernels.push(k);
      }
      this.ft = 16; // smoothed frame time, ms
      this.slowFrames = 0;
      // offscreen canvas at cell resolution for shape-drawn scenes
      this.off = document.createElement("canvas");
      this.off.width = this.cols;
      this.off.height = this.rows;
      this.octx = this.off.getContext("2d", { willReadFrequently: true });
      if (this.scene.layout) this.scene.layout(this);
    }

    bind() {
      let raf = null;
      window.addEventListener("resize", () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => this.resize());
      });
      const move = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.cursor.x = ((e.clientX - rect.left) * this.dpr - this.ox) / this.cp;
        this.cursor.y = ((e.clientY - rect.top) * this.dpr - this.oy) / this.cp;
        this.cursor.nx = (e.clientX / window.innerWidth) * 2 - 1;
        this.cursor.ny = (e.clientY / window.innerHeight) * 2 - 1;
        this.cursor.in = true;
      };
      window.addEventListener("pointermove", move, { passive: true });
      document.addEventListener("pointerleave", () => (this.cursor.in = false));
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.stop();
        else this.start();
      });
    }

    /* read the offscreen canvas (drawn by a scene) into the buffer, additively */
    readOffscreen(gain) {
      const d = this.octx.getImageData(0, 0, this.cols, this.rows).data;
      const buf = this.buf;
      const n = this.cols * this.rows;
      for (let i = 0; i < n; i++) {
        const a = d[i * 4 + 3];
        if (a) buf[i] += ((d[i * 4] / 255) * a * (gain || 1)) / 255;
      }
    }

    sample(x, y) {
      const x0 = Math.floor(x),
        y0 = Math.floor(y);
      const fx = x - x0,
        fy = y - y0;
      const cols = this.cols,
        rows = this.rows,
        buf = this.buf;
      const get = (cx, cy) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? 0 : buf[cy * cols + cx]);
      return get(x0, y0) * (1 - fx) * (1 - fy) + get(x0 + 1, y0) * fx * (1 - fy) + get(x0, y0 + 1) * (1 - fx) * fy + get(x0 + 1, y0 + 1) * fx * fy;
    }

    frame(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      const t0 = performance.now();
      this.buf.fill(0);
      this.scene.update(this, dt);
      this.scene.draw(this);
      this.warp(dt);
      this.paint();
      // adaptive quality: if frames stay slow, use larger cells
      this.ft += (performance.now() - t0 - this.ft) * 0.1;
      if (this.ft > 26 && this.cell < 7) {
        if (++this.slowFrames > 45) {
          this.cell += 1;
          this.slowFrames = 0;
          this.resize();
        }
      } else this.slowFrames = 0;
    }

    /* cursor gravity: cells near the pointer sample the buffer slightly
       farther out, so the picture appears pulled toward the cursor */
    warp(dt) {
      const target = this.cursor.in && !REDUCED && this.scene.warp !== false ? 1 : 0;
      this.cursor.w += (target - this.cursor.w) * Math.min(1, dt * 4);
      const w = this.cursor.w;
      const out = this.out,
        buf = this.buf;
      if (w < 0.01) {
        out.set(buf);
        return;
      }
      out.set(buf);
      const cx = this.cursor.x,
        cy = this.cursor.y;
      const R = 70 / this.cell; // influence radius in cells (~70px)
      const r0 = Math.max(0, Math.floor(cy - R)),
        r1 = Math.min(this.rows - 1, Math.ceil(cy + R));
      const c0 = Math.max(0, Math.floor(cx - R)),
        c1 = Math.min(this.cols - 1, Math.ceil(cx + R));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const dx = c + 0.5 - cx;
          const dy = r + 0.5 - cy;
          const d = Math.hypot(dx, dy);
          if (d > R || d < 0.001) continue;
          const k = w * R * 0.22 * (1 - d / R) * (1 - d / R);
          const sx = c + 0.5 + (dx / d) * k;
          const sy = r + 0.5 + (dy / d) * k;
          out[r * this.cols + c] = this.sample(sx - 0.5, sy - 0.5);
        }
      }
    }

    paint() {
      const img = this.img,
        px = img.data;
      px.set(this.bgData);
      const pw = this.pw,
        ph = this.ph;
      const out = this.out;
      const cols = this.cols,
        rows = this.rows,
        cp = this.cp;
      const ks = this.kSize,
        kh = ks / 2,
        kN = this.kN;
      let count = 0;
      for (let r = 0; r < rows; r++) {
        const cyp = this.oy + r * cp + cp / 2;
        const y0 = Math.round(cyp - kh);
        for (let c = 0; c < cols; c++) {
          let v = out[r * cols + c];
          if (v < 0.02) continue;
          if (v > 1) v = 1;
          count++;
          const kern = this.kernels[Math.min(kN - 1, (v * kN) | 0)];
          const li = Math.round(Math.pow(v, 0.8) * 255) * 3;
          const cr = LUT[li],
            cg = LUT[li + 1],
            cb = LUT[li + 2];
          const x0 = Math.round(this.ox + c * cp + cp / 2 - kh);
          for (let ky = 0; ky < ks; ky++) {
            const y = y0 + ky;
            if (y < 0 || y >= ph) continue;
            for (let kx = 0; kx < ks; kx++) {
              const cov = kern[ky * ks + kx];
              if (cov <= 0) continue;
              const x = x0 + kx;
              if (x < 0 || x >= pw) continue;
              const i = (y * pw + x) * 4;
              px[i] += (cr - px[i]) * cov;
              px[i + 1] += (cg - px[i + 1]) * cov;
              px[i + 2] += (cb - px[i + 2]) * cov;
            }
          }
        }
      }
      this.ctx.putImageData(img, 0, 0);
      if (this.onPaint) this.onPaint(count);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        this.frame(now);
        if (REDUCED) {
          this.running = false;
          return;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
    }
  }

  /* ------------------------------------------------------------ black hole */

  function blackhole() {
    const elev = (16 * Math.PI) / 180; // camera elevation above the disk plane
    const sinE = Math.sin(elev);
    const R_IN = 1.3,
      R_OUT = 4.6;
    let S = 10,
      cx = 0,
      cy = 0;
    // per-cell lens tables, computed once per layout (geometry is static; only the disk texture moves)
    let T = null;

    // starfield in 3D, drifting toward the hole
    const NS = 900;
    const stars = new Float32Array(NS * 5); // x, y, z(depth 0..1), seed, speed
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const spawn = (i, edge) => {
      const a = rnd() * Math.PI * 2;
      const rr = edge ? 9 + rnd() * 3 : 1.4 + rnd() * 10;
      stars[i * 5] = Math.cos(a) * rr * 1.6;
      stars[i * 5 + 1] = Math.sin(a) * rr;
      stars[i * 5 + 2] = 0.25 + rnd() * 0.75;
      stars[i * 5 + 3] = rnd() * 6.28;
      stars[i * 5 + 4] = 0.6 + rnd() * 0.8;
    };
    for (let i = 0; i < NS; i++) spawn(i, false);

    // static part of the disk brightness at (rho, cos phi): radial profile × doppler
    const diskK = (rho, c) => {
      if (rho < R_IN || rho > R_OUT) return 0;
      let b = Math.pow(R_IN / rho, 1.6);
      b *= smooth(R_IN, R_IN + 0.18, rho) * (1 - smooth(R_OUT - 1.1, R_OUT, rho));
      b *= Math.pow(1 + 0.42 * c, 2.2); // beaming: the side moving toward us (right) is brighter
      return b * 0.72;
    };

    // solve the lens for one screen point; returns [rho, phi, gain] or null
    const solve = (X, Y, mirror) => {
      const r = Math.hypot(X, Y);
      if (r < 1e-4) return null;
      let far = r < 1 ? 0 : 0.5; // inside the shadow only the near side can show
      let th2 = mirror < 0 ? 1.25 : 0.06 + 1.1 * far * far;
      let rho = 0,
        phi = 0,
        gain = 0;
      for (let it = 0; it < 4; it++) {
        const bI = r - th2 / r; // undo the lens: b_out = (b + sqrt(b^2 + 4 th2)) / 2
        if (bI <= 0) return null;
        const k = bI / r;
        const Xs = X * k * (mirror < 0 ? 1.02 : 1);
        const Ys = Y * k * mirror;
        rho = Math.hypot(Xs, Ys / sinE);
        const s = Ys / sinE / rho; // sin(phi): > 0 near side
        const c = Xs / rho;
        phi = Math.atan2(s, c);
        if (mirror > 0) {
          if (r < 1 && s < 0) return null; // far-side light with b_out < 1 falls in
          far = r < 1 ? 0 : 0.5 * (1 - s);
          th2 = 0.06 + 1.1 * far * far;
          gain = diskK(rho, c) * Math.min(2.2, 0.55 + r / Math.max(bI, 1e-3)); // magnification
        } else {
          gain = diskK(rho, c) * 0.18;
          break;
        }
      }
      return gain > 0 ? [rho, phi, gain] : null;
    };

    return {
      layout(f) {
        S = Math.min(f.cols * 0.95, f.rows * 1.3) * 0.135;
        cx = f.cols * (f.cols > f.rows * 1.2 ? 0.56 : 0.5);
        cy = f.rows * 0.47;
        const n = f.cols * f.rows;
        // per cell: gain, phase a1..a3 and angular speed w for primary (1) and secondary (2); ring glow; shadow flag
        T = {
          g1: new Float32Array(n),
          p1: new Float32Array(n * 3),
          w1: new Float32Array(n),
          g2: new Float32Array(n),
          p2: new Float32Array(n * 3),
          w2: new Float32Array(n),
          glow: new Float32Array(n),
          shadow: new Uint8Array(n),
          active: [],
        };
        for (let r = 0; r < f.rows; r++) {
          const Y = (r + 0.5 - cy) / S;
          for (let c = 0; c < f.cols; c++) {
            const X = (c + 0.5 - cx) / S;
            const rr = X * X + Y * Y;
            const i = r * f.cols + c;
            if (rr > 36) continue;
            const rad = Math.sqrt(rr);
            T.shadow[i] = rad < 1 ? 1 : 0;
            T.glow[i] = 0.55 * Math.exp(-Math.pow((rad - 1.03) / 0.045, 2));
            const a = solve(X, Y, 1);
            if (a) {
              T.g1[i] = a[2];
              T.p1[i * 3] = 3 * a[1] + 9.0 * a[0];
              T.p1[i * 3 + 1] = 7 * a[1] - 5.5 * a[0] + 1.3;
              T.p1[i * 3 + 2] = 13 * a[1] + 21.0 * a[0] + 0.4;
              T.w1[i] = 0.5 / Math.pow(a[0], 1.5);
            }
            const b = rad > 1.1 ? solve(X, Y, -1) : null;
            if (b) {
              T.g2[i] = b[2];
              T.p2[i * 3] = 3 * b[1] + 9.0 * b[0];
              T.p2[i * 3 + 1] = 7 * b[1] - 5.5 * b[0] + 1.3;
              T.p2[i * 3 + 2] = 13 * b[1] + 21.0 * b[0] + 0.4;
              T.w2[i] = 0.5 / Math.pow(b[0], 1.5);
            }
            if (a || b || T.glow[i] > 0.01 || T.shadow[i]) T.active.push(i);
          }
        }
      },
      update(f, dt) {
        // stars fall toward the hole, with a sideways swirl, and respawn at the rim
        const g = dt * 0.9;
        for (let i = 0; i < NS; i++) {
          let x = stars[i * 5],
            y = stars[i * 5 + 1];
          const z = stars[i * 5 + 2];
          const d = Math.hypot(x, y) + 1e-3;
          const a = (g * stars[i * 5 + 4]) / (d * d * 0.35 + 0.6);
          x -= (x / d) * a - (y / d) * a * 0.55;
          y -= (y / d) * a + (x / d) * a * 0.55;
          if (d < 1.15 * (0.6 + z * 0.5)) spawn(i, true);
          else {
            stars[i * 5] = x;
            stars[i * 5 + 1] = y;
          }
        }
      },
      draw(f) {
        const t = f.t;
        const buf = f.buf;
        const cols = f.cols,
          rows = f.rows;
        // parallax from the cursor
        const px = f.cursor.in ? f.cursor.nx : 0,
          py = f.cursor.in ? f.cursor.ny : 0;
        // stars first (occluded by the disk and swallowed by the shadow)
        for (let i = 0; i < NS; i++) {
          const z = stars[i * 5 + 2];
          const X = stars[i * 5] + px * (1 - z) * 0.9;
          const Y = stars[i * 5 + 1] + py * (1 - z) * 0.9;
          const c = Math.round(cx + X * S),
            r = Math.round(cy + Y * S);
          if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
          const tw = 0.6 + 0.4 * fsin(t * 1.3 * stars[i * 5 + 4] + stars[i * 5 + 3]);
          buf[r * cols + c] += (0.1 + 0.3 * z) * tw;
        }
        // the hole and its disk, from the precomputed tables
        const { g1, p1, w1, g2, p2, w2, glow, shadow, active } = T;
        for (let k = 0; k < active.length; k++) {
          const i = active[k];
          let b = glow[i];
          if (g1[i] > 0) {
            const ph = w1[i] * t;
            b += g1[i] * (0.62 + 0.2 * fsin(p1[i * 3] + 3 * ph) + 0.12 * fsin(p1[i * 3 + 1] + 7 * ph) + 0.06 * fsin(p1[i * 3 + 2] + 13 * ph));
          }
          if (g2[i] > 0) {
            const ph = w2[i] * t;
            b += g2[i] * (0.62 + 0.2 * fsin(p2[i * 3] + 3 * ph) + 0.12 * fsin(p2[i * 3 + 1] + 7 * ph) + 0.06 * fsin(p2[i * 3 + 2] + 13 * ph));
          }
          if (shadow[i])
            buf[i] = b; // the shadow swallows stars; the near disk still crosses it
          else buf[i] += b;
        }
      },
    };
  }

  /* ------------------------------------------------------------- humanoid */

  // An upper-body humanoid in the style of current general-purpose robots:
  // glossy visor with a light halo, hard chest shell over a dark abdomen,
  // shoulder sockets, tapered arm shells with black joints, mechanical hands.
  // Drawn with canvas shapes into the offscreen cell buffer; the head follows
  // the cursor. On load the dots rise from below and settle into the figure,
  // and afterwards a quiet stream keeps flowing up into the body.
  function humanoid(pose) {
    let look = { x: 0, y: 0 };
    let u = 1; // world unit in cells; the figure is ~24 units from crown to the panel's bottom
    let ox = 0,
      oy = 0;
    let temp = null;
    const ASSEMBLE = 2.6; // seconds for the particles to settle

    // the perpetual stream: particles rising from below the waist
    const NP = 170;
    const P = new Float32Array(NP * 4); // x, y, speed, phase
    let seed = 29;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const respawn = (i, y) => {
      P[i * 4] = (rnd() - 0.5) * 9;
      P[i * 4 + 1] = y;
      P[i * 4 + 2] = 2.2 + rnd() * 2.6;
      P[i * 4 + 3] = rnd() * 6.28;
    };
    for (let i = 0; i < NP; i++) respawn(i, 14 + rnd() * 12);

    return {
      warp: false,
      layout(f) {
        u = Math.min(f.rows / 24.5, f.cols / 20);
        ox = f.cols * 0.44; // the raised right arm needs room
        oy = f.rows / 2 - 11.8 * u;
        temp = new Float32Array(f.cols * f.rows);
      },
      update(f, dt) {
        let tx = 0,
          ty = 0;
        if (f.cursor.in) {
          tx = clamp((f.cursor.x - ox) / (f.cols * 0.5), -1, 1);
          ty = clamp((f.cursor.y - (oy + 4 * u)) / (f.rows * 0.5), -1, 1);
        }
        const k = Math.min(1, dt * 5);
        look.x += (tx - look.x) * k;
        look.y += (ty - look.y) * k;
        for (let i = 0; i < NP; i++) {
          P[i * 4 + 1] -= P[i * 4 + 2] * dt;
          P[i * 4] += Math.sin(f.t * 1.7 + P[i * 4 + 3]) * dt * 0.6;
          if (P[i * 4 + 1] < 13.5) respawn(i, 25.5 + rnd() * 3);
        }
      },
      draw(f) {
        const g = f.octx;
        const t = f.t;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, f.cols, f.rows);
        g.setTransform(u, 0, 0, u, ox, oy);
        g.lineCap = "round";
        g.lineJoin = "round";
        const breathe = Math.sin(t * 1.1) * 0.06;
        const W = (v) => `rgba(255,255,255,${clamp(v, 0, 1)})`;

        // hard shell: lit from the upper right
        const shell = (x0, y0, x1, y1, lo, hi) => {
          const gr = g.createLinearGradient(x0, y0, x1, y1);
          gr.addColorStop(0, W(lo));
          gr.addColorStop(1, W(hi));
          return gr;
        };
        const stroke = (x1, y1, x2, y2, w, style) => {
          g.strokeStyle = style;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(x1, y1);
          g.lineTo(x2, y2);
          g.stroke();
        };
        const dot = (x, y, r, style) => {
          g.fillStyle = style;
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.fill();
        };
        const poly = (pts, style) => {
          g.fillStyle = style;
          g.beginPath();
          g.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
          g.closePath();
          g.fill();
        };
        // tapered shell segment from (x1,y1) width w1 to (x2,y2) width w2, with rounded ends
        const tapered = (x1, y1, w1, x2, y2, w2, lo, hi) => {
          const dx = x2 - x1,
            dy = y2 - y1;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len,
            ny = dx / len;
          const style = shell(x1 + nx * w1, y1 + ny * w1, x1 - nx * w1, y1 - ny * w1, lo, hi);
          poly(
            [
              [x1 + (nx * w1) / 2, y1 + (ny * w1) / 2],
              [x2 + (nx * w2) / 2, y2 + (ny * w2) / 2],
              [x2 - (nx * w2) / 2, y2 - (ny * w2) / 2],
              [x1 - (nx * w1) / 2, y1 - (ny * w1) / 2],
            ],
            style
          );
          dot(x1, y1, w1 / 2, style);
          dot(x2, y2, w2 / 2, style);
        };
        // black mechanical joint with a specular glint
        const joint = (x, y, r) => {
          dot(x, y, r, W(0.13));
          dot(x + r * 0.3, y - r * 0.3, r * 0.3, W(0.4));
        };
        // mechanical hand: dark palm, five two-segment fingers with pale knuckles.
        // `a` is the direction the fingers point (radians, 0 = up), `curl` closes them.
        const hand = (hx, hy, a, curl) => {
          dot(hx, hy, 0.78, W(0.2));
          dot(hx + 0.15, hy - 0.2, 0.36, W(0.3));
          const finger = (base, len1, len2, w) => {
            const fa = a + base;
            const j1x = hx + Math.sin(fa) * len1,
              j1y = hy - Math.cos(fa) * len1;
            const fb = fa + curl * 0.9;
            const tipx = j1x + Math.sin(fb) * len2,
              tipy = j1y - Math.cos(fb) * len2;
            stroke(hx + Math.sin(fa) * 0.5, hy - Math.cos(fa) * 0.5, j1x, j1y, w, W(0.42));
            stroke(j1x, j1y, tipx, tipy, w * 0.85, W(0.42));
            dot(j1x, j1y, w * 0.45, W(0.16));
          };
          finger(-0.4, 1.15, 0.85, 0.36);
          finger(-0.13, 1.35, 0.95, 0.38);
          finger(0.13, 1.3, 0.95, 0.38);
          finger(0.4, 1.1, 0.8, 0.36);
          const ta = a - 1.25;
          const t1x = hx + Math.sin(ta) * 0.9,
            t1y = hy - Math.cos(ta) * 0.9;
          stroke(hx, hy, t1x, t1y, 0.4, W(0.42));
          stroke(t1x, t1y, t1x + Math.sin(ta + 0.9 + curl) * 0.65, t1y - Math.cos(ta + 0.9 + curl) * 0.65, 0.34, W(0.42));
        };

        const sy = 7.0 + breathe * 0.3; // top of the chest

        // ---- shoulder sockets: dark, under the shells
        dot(-4.5, sy + 2.0, 1.5, W(0.13));
        dot(4.5, sy + 2.0, 1.5, W(0.13));

        // ---- abdomen: dark, flexible section under the chest shell
        poly(
          [
            [-3.5, 12.8],
            [3.5, 12.8],
            [3.0, 18.6],
            [-3.0, 18.6],
          ],
          W(0.14)
        );
        stroke(-2.6, 15.2, 2.6, 15.2, 0.12, W(0.22));
        stroke(-2.7, 16.6, 2.7, 16.6, 0.12, W(0.22));

        // ---- chest shell: clavicle line, pectoral contours, V cut at the bottom
        g.fillStyle = shell(-4.5, 14, 4, 7, 0.34, 0.66);
        g.beginPath();
        g.moveTo(-1.5, sy);
        g.lineTo(-3.9, sy + 0.35); // left clavicle
        g.quadraticCurveTo(-4.7, sy + 0.9, -4.6, sy + 2.3); // shoulder edge
        g.lineTo(-4.3, 11.6); // flank, nearly straight
        g.quadraticCurveTo(-4.2, 13.5, -3.3, 14.1); // lower corner
        g.lineTo(-0.7, 14.9); // shallow V
        g.lineTo(0, 15.05);
        g.lineTo(0.7, 14.9);
        g.lineTo(3.3, 14.1);
        g.quadraticCurveTo(4.2, 13.5, 4.3, 11.6);
        g.lineTo(4.6, sy + 2.3);
        g.quadraticCurveTo(4.7, sy + 0.9, 3.9, sy + 0.35);
        g.lineTo(1.5, sy);
        g.closePath();
        g.fill();
        // pectoral contours and the center seam
        g.strokeStyle = W(0.2);
        g.lineWidth = 0.14;
        g.beginPath();
        g.moveTo(-3.9, 11.2);
        g.quadraticCurveTo(-2.2, 12.8, -0.4, 11.6);
        g.moveTo(3.9, 11.2);
        g.quadraticCurveTo(2.2, 12.8, 0.4, 11.6);
        g.stroke();
        stroke(0, sy + 1.6, 0, 11.2, 0.12, W(0.22));
        stroke(-1.1, sy + 0.9, 1.1, sy + 0.9, 0.16, W(0.78 + 0.22 * Math.sin(t * 2))); // collar light

        // ---- pelvis shell and hip joints, cut by the bottom of the panel
        g.fillStyle = shell(-3, 20, 3, 17, 0.28, 0.5);
        g.beginPath();
        g.moveTo(-3.1, 18.2);
        g.lineTo(3.1, 18.2);
        g.quadraticCurveTo(3.6, 20.8, 2.4, 21.6);
        g.lineTo(-2.4, 21.6);
        g.quadraticCurveTo(-3.6, 20.8, -3.1, 18.2);
        g.closePath();
        g.fill();
        joint(-2.0, 22.6, 1.0);
        joint(2.0, 22.6, 1.0);
        poly(
          [
            [-2.8, 22.8],
            [-1.1, 22.8],
            [-1.3, 25],
            [-3.0, 25],
          ],
          W(0.16)
        );
        poly(
          [
            [1.1, 22.8],
            [2.8, 22.8],
            [3.0, 25],
            [1.3, 25],
          ],
          W(0.16)
        );

        // ---- arms
        const arm = (side, elx, ely, wrx, wry) => {
          const shx = side * 4.6,
            shy = sy + 2.0;
          // upper arm shell, tapering to the elbow
          tapered(shx, shy, 1.9, elx, ely, 1.35, 0.28, 0.58);
          dot(shx, shy, 1.1, shell(shx - 1, shy + 1, shx + 1, shy - 1, 0.32, 0.62)); // shoulder cap
          joint(elx, ely, 0.72);
          // forearm shell, tapering to the wrist, with a dark actuator window
          tapered(elx, ely, 1.3, wrx, wry, 0.95, 0.26, 0.56);
          const mx = (elx + wrx) / 2,
            my = (ely + wry) / 2;
          const dx = wrx - elx,
            dy = wry - ely;
          const len = Math.hypot(dx, dy) || 1;
          stroke(mx - (dx / len) * 1.2, my - (dy / len) * 1.2, mx + (dx / len) * 1.2, my + (dy / len) * 1.2, 0.5, W(0.14));
          joint(wrx, wry, 0.52);
        };

        // left arm (viewer's left): hanging, slight sway
        {
          const sw = Math.sin(t * 0.9) * 0.1;
          const elx = -5.6 + sw,
            ely = 14.0;
          const wrx = -5.9 + sw * 2,
            wry = 19.4;
          arm(-1, elx, ely, wrx, wry);
          hand(wrx - 0.1, wry + 1.25, Math.PI + 0.15, 0.4);
        }
        // right arm: wave, or hold a cube
        if (pose === "wave") {
          const a = Math.sin(t * 5.2) * 0.42;
          const elx = 4.6 + 2.6,
            ely = sy + 2.0 + 2.9;
          const dir = a + 0.28;
          const wrx = elx + Math.sin(dir) * 5.0,
            wry = ely - Math.cos(dir) * 5.0;
          arm(1, elx, ely, wrx, wry);
          hand(wrx + Math.sin(dir) * 1.05, wry - Math.cos(dir) * 1.05, dir, 0.05);
        } else {
          const lift = Math.sin(t * 1.4) * 0.12;
          const elx = 4.6 + 2.3,
            ely = sy + 2.0 + 4.7;
          const wrx = elx + 0.7,
            wry = ely - 4.2 + lift;
          arm(1, elx, ely, wrx, wry);
          hand(wrx + 0.2, wry - 0.9, -0.2, 0.55);
          const ca = t * 0.9,
            cb = t * 0.55;
          const cxp = wrx + 0.3,
            cyp = wry - 2.9 + lift;
          const size = 1.15;
          const pts = [];
          for (let i = 0; i < 8; i++) {
            const x = i & 1 ? 1 : -1,
              y = i & 2 ? 1 : -1,
              z = i & 4 ? 1 : -1;
            const x1 = x * Math.cos(ca) + z * Math.sin(ca);
            let z1 = -x * Math.sin(ca) + z * Math.cos(ca);
            const y1 = y * Math.cos(cb) - z1 * Math.sin(cb);
            z1 = y * Math.sin(cb) + z1 * Math.cos(cb);
            const pr = 1 / (1 + z1 * 0.18);
            pts.push([cxp + x1 * size * pr, cyp + y1 * size * pr, z1]);
          }
          const edges = [
            [0, 1],
            [1, 3],
            [3, 2],
            [2, 0],
            [4, 5],
            [5, 7],
            [7, 6],
            [6, 4],
            [0, 4],
            [1, 5],
            [2, 6],
            [3, 7],
          ];
          for (const [a1, b1] of edges) {
            const v = 0.5 + 0.45 * ((pts[a1][2] + pts[b1][2]) / 4 + 0.5);
            stroke(pts[a1][0], pts[a1][1], pts[b1][0], pts[b1][1], 0.3, W(v));
          }
          for (const pt of pts) dot(pt[0], pt[1], 0.24, W(0.6 + 0.4 * (pt[2] / 2 + 0.5)));
        }

        // ---- neck and head, turned toward the cursor
        poly(
          [
            [-0.9, 5.3],
            [0.9, 5.3],
            [1.2, sy + 0.3],
            [-1.2, sy + 0.3],
          ],
          W(0.18)
        );
        const hx0 = look.x * 0.7,
          hy0 = 3.0 + breathe * 0.2 + look.y * 0.3;
        g.save();
        g.translate(hx0, hy0);
        g.rotate(look.x * 0.14);
        // visor: glossy black egg with a soft highlight on the upper left
        g.fillStyle = W(0.16);
        g.beginPath();
        g.ellipse(0, 0, 2.3, 3.0, 0, 0, Math.PI * 2);
        g.fill();
        const hl = g.createRadialGradient(-0.9, -1.5, 0.2, -0.9, -1.5, 2.1);
        hl.addColorStop(0, W(0.42));
        hl.addColorStop(1, W(0));
        g.fillStyle = hl;
        g.beginPath();
        g.ellipse(0, 0, 2.3, 3.0, 0, 0, Math.PI * 2);
        g.fill();
        // light halo tracing the face edge, brighter where it faces the cursor
        g.strokeStyle = W(0.85);
        g.lineWidth = 0.2;
        g.beginPath();
        g.ellipse(0.25 + look.x * 0.3, -0.1, 1.55, 2.25, 0, Math.PI * 1.15, Math.PI * 1.95);
        g.stroke();
        g.strokeStyle = W(0.45);
        g.beginPath();
        g.ellipse(0.25 + look.x * 0.3, -0.1, 1.55, 2.25, 0, Math.PI * 0.05, Math.PI * 0.55);
        g.stroke();
        dot(0.35, -1.5, 0.2, W(0.5)); // sensor
        g.restore();

        // ---- read back; then the assembly effect and the perpetual stream
        f.readOffscreen(1);
        const buf = f.buf,
          cols = f.cols,
          rows = f.rows;
        const p = REDUCED ? 1 : clamp(t / ASSEMBLE, 0, 1);
        if (p < 1) {
          temp.set(buf);
          buf.fill(0);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const v = temp[r * cols + c];
              if (v < 0.02) continue;
              // bottom rows settle first; each cell has its own small delay
              const h = ((c * 374761393 + r * 668265263) ^ 0x5bd1e995) >>> 0;
              const jit = (h % 1000) / 1000;
              const order = 1 - r / rows;
              const q = clamp((p - order * 0.55 - jit * 0.25) / 0.3, 0, 1);
              const e = 1 - Math.pow(1 - q, 3);
              const dx = Math.sin(h % 360) * 10 * (1 - e);
              const dy = (rows - r + 12) * (1 - e);
              const cx2 = Math.round(c + dx),
                cy2 = Math.round(r + dy);
              if (cx2 < 0 || cy2 < 0 || cx2 >= cols || cy2 >= rows) continue;
              buf[cy2 * cols + cx2] += v * (0.35 + 0.65 * e);
            }
          }
        }
        // stream: faint at the bottom, brightening as it rises, merging into the body
        if (!REDUCED) {
          const gain = p < 1 ? p : 1;
          for (let i = 0; i < NP; i++) {
            const x = P[i * 4],
              y = P[i * 4 + 1];
            const c = Math.round(ox + x * u),
              r = Math.round(oy + y * u);
            if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
            const rise = clamp((25 - y) / 9, 0, 1); // 0 at the bottom, 1 near the waist
            const v = (0.06 + 0.7 * rise * rise) * (0.7 + 0.3 * Math.sin(t * 5 + P[i * 4 + 3])) * gain;
            buf[r * cols + c] += v;
          }
        }
      },
    };
  }

  /* ------------------------------------------------------------------ boot */

  const SCENES = {
    blackhole,
    "robot-wave": () => humanoid("wave"),
    "robot-cube": () => humanoid("cube"),
  };

  function boot() {
    document.querySelectorAll("canvas[data-scene]").forEach((canvas) => {
      const make = SCENES[canvas.dataset.scene];
      if (!make) return;
      const field = new Field(canvas, make(), { cell: Number(canvas.dataset.cell) || 5 });
      const counter = canvas.dataset.counter ? document.querySelector(canvas.dataset.counter) : null;
      if (counter) {
        let lastN = -1;
        field.onPaint = (n) => {
          const q = Math.round(n / 100) * 100;
          if (q !== lastN) {
            lastN = q;
            counter.textContent = q.toLocaleString("en-US");
          }
        };
      }
      field.start();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
