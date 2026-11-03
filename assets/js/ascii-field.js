/*
 * ascii-field.js — character-grid renderer for the site's animated scenes.
 *
 * Every scene writes brightness into a cols × rows float buffer; the field
 * then maps brightness to a character ramp and a blue-to-white palette and
 * draws it to a <canvas>. Zero dependencies.
 *
 * Usage: <canvas data-scene="blackhole|lorenz|pendulum" data-font="13"></canvas>
 */
(function () {
  "use strict";

  const RAMP = " .·:;=+*#%@";
  const PALETTE = ["#161f3d", "#223068", "#2f4aa8", "#4f7cff", "#8fb0ff", "#cfe0ff", "#f3f7ff"];
  const STAR_COLOR = "#2c3550";
  const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------------- field */

  class Field {
    constructor(canvas, scene, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.scene = scene;
      this.fontPx = opts.fontPx || 13;
      this.bg = opts.bg || "#090a0e";
      this.cursor = { x: -1e9, y: -1e9, w: 0 }; // w = influence 0..1
      this.t = 0;
      this.last = performance.now();
      this.running = false;
      this.cols = 0;
      this.rows = 0;
      this.resize();
      this.bind();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dpr = dpr;
      this.w = w;
      this.h = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.font = `${this.fontPx}px "Geist Mono", ui-monospace, Menlo, monospace`;
      this.ctx.textBaseline = "top";
      this.cw = this.ctx.measureText("M").width || this.fontPx * 0.6;
      this.ch = this.fontPx * 1.15;
      this.cols = Math.max(1, Math.floor(w / this.cw));
      this.rows = Math.max(1, Math.floor(h / this.ch));
      this.ox = (w - this.cols * this.cw) / 2;
      this.oy = (h - this.rows * this.ch) / 2;
      this.buf = new Float32Array(this.cols * this.rows);
      this.out = new Float32Array(this.cols * this.rows);
      this.stars = this.makeStars();
      if (this.scene.layout) this.scene.layout(this);
      this.ctx.font = `${this.fontPx}px "Geist Mono", ui-monospace, Menlo, monospace`;
      this.ctx.textBaseline = "top";
    }

    makeStars() {
      const list = [];
      const n = Math.floor((this.cols * this.rows) / 38);
      let seed = 1234;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < n; i++) {
        list.push({ c: Math.floor(rnd() * this.cols), r: Math.floor(rnd() * this.rows), p: rnd() * 6.28, s: 0.4 + rnd() * 1.2 });
      }
      return list;
    }

    bind() {
      let raf = null;
      window.addEventListener("resize", () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => this.resize());
      });
      const move = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        this.cursor.x = (e.clientX - rect.left - this.ox) / this.cw;
        this.cursor.y = (e.clientY - rect.top - this.oy) / this.ch;
        this.cursor.in = true;
      };
      window.addEventListener("pointermove", move, { passive: true });
      window.addEventListener("pointerleave", () => (this.cursor.in = false));
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) this.stop();
        else this.start();
      });
    }

    /* splat brightness b at fractional cell (x, y), bilinear into 4 cells */
    splat(x, y, b) {
      if (b <= 0) return;
      const x0 = Math.floor(x),
        y0 = Math.floor(y);
      const fx = x - x0,
        fy = y - y0;
      const cols = this.cols,
        rows = this.rows,
        buf = this.buf;
      const add = (cx, cy, v) => {
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
        buf[cy * cols + cx] += v;
      };
      add(x0, y0, b * (1 - fx) * (1 - fy));
      add(x0 + 1, y0, b * fx * (1 - fy));
      add(x0, y0 + 1, b * (1 - fx) * fy);
      add(x0 + 1, y0 + 1, b * fx * fy);
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
      this.buf.fill(0);
      this.scene.update(this, dt);
      this.scene.draw(this);
      this.warp(dt);
      this.paint();
    }

    /* cursor gravity: cells near the pointer sample the buffer slightly
       farther out, so the picture appears pulled toward the cursor */
    warp(dt) {
      const target = this.cursor.in && !REDUCED ? 1 : 0;
      this.cursor.w += (target - this.cursor.w) * Math.min(1, dt * 4);
      const w = this.cursor.w;
      const out = this.out,
        buf = this.buf;
      if (w < 0.01) {
        out.set(buf);
        return;
      }
      const cx = this.cursor.x,
        cy = this.cursor.y;
      const aspect = this.ch / this.cw; // rows are taller than cols are wide
      const R = 14; // influence radius in cols
      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          const dx = c + 0.5 - cx;
          const dy = (r + 0.5 - cy) * aspect;
          const d = Math.hypot(dx, dy);
          if (d > R || d < 0.001) {
            out[r * this.cols + c] = buf[r * this.cols + c];
            continue;
          }
          const k = w * 3.2 * (1 - d / R) * (1 - d / R);
          const sx = c + 0.5 + (dx / d) * k;
          const sy = r + 0.5 + (dy / d) * (k / aspect);
          out[r * this.cols + c] = this.sample(sx - 0.5, sy - 0.5);
        }
      }
    }

    paint() {
      const ctx = this.ctx;
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, this.w, this.h);
      const out = this.out;
      const cols = this.cols,
        rows = this.rows;
      const levels = PALETTE.length;
      const buckets = new Array(levels);
      for (let i = 0; i < levels; i++) buckets[i] = [];
      const nR = RAMP.length - 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = out[r * cols + c];
          if (v < 0.03) continue;
          const b = Math.min(1, v);
          const ci = Math.max(1, Math.round(Math.pow(b, 0.85) * nR));
          const li = Math.min(levels - 1, Math.floor(Math.pow(b, 0.9) * levels));
          buckets[li].push(c, r, ci);
        }
      }
      // stars first so content paints over them
      if (this.scene.stars !== false) {
        ctx.fillStyle = STAR_COLOR;
        const t = this.t;
        for (const s of this.stars) {
          const i = s.r * cols + s.c;
          if (out[i] > 0.03) continue;
          const tw = 0.5 + 0.5 * Math.sin(t * s.s + s.p);
          if (tw < 0.35) continue;
          ctx.fillText(tw > 0.8 ? "·" : ".", this.ox + s.c * this.cw, this.oy + s.r * this.ch);
        }
      }
      for (let li = 0; li < levels; li++) {
        const list = buckets[li];
        if (!list.length) continue;
        ctx.fillStyle = PALETTE[li];
        for (let i = 0; i < list.length; i += 3) {
          ctx.fillText(RAMP[list[i + 2]], this.ox + list[i] * this.cw, this.oy + list[i + 1] * this.ch);
        }
      }
      if (this.onPaint) this.onPaint(buckets.reduce((n, b) => n + b.length / 3, 0));
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
    const N = 9000;
    const P = new Float32Array(N * 4); // rho, phi, jitter, seed
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < N; i++) {
      // denser toward the inner edge
      const u = rnd();
      const rho = 1.35 + 2.9 * u * u;
      P[i * 4] = rho;
      P[i * 4 + 1] = rnd() * Math.PI * 2;
      P[i * 4 + 2] = 0.55 + rnd() * 0.9;
      P[i * 4 + 3] = rnd() * Math.PI * 2;
    }
    const elev = (17 * Math.PI) / 180; // camera elevation above the disk plane
    const sinE = Math.sin(elev),
      cosE = Math.cos(elev);
    let S = 10,
      cx = 0,
      cy = 0,
      aspect = 1;

    return {
      layout(f) {
        aspect = f.cw / f.ch; // world->row scale correction
        const wCols = f.cols,
          hRows = f.rows / aspect; // rows measured in col-widths
        S = Math.min(wCols * 0.95, hRows * 1.25) * 0.14;
        cx = f.cols * (f.cols > 90 ? 0.56 : 0.5);
        cy = f.rows * 0.46;
      },
      update(f, dt) {
        for (let i = 0; i < N; i++) {
          const rho = P[i * 4];
          P[i * 4 + 1] += (dt * 0.42) / Math.pow(rho, 1.5);
        }
      },
      draw(f) {
        const t = f.t;
        const toCell = (X, Y) => [cx + X * S, cy + Y * S * aspect];
        // thin photon ring hugging the shadow
        const ringN = 200;
        for (let i = 0; i < ringN; i++) {
          const a = (i / ringN) * Math.PI * 2;
          const [x, y] = toCell(Math.cos(a) * 1.03, Math.sin(a) * 1.03);
          f.splat(x, y, 0.16 + 0.08 * Math.sin(a * 2 + t * 0.6));
        }
        const near = [];
        for (let i = 0; i < N; i++) {
          const rho = P[i * 4],
            phi = P[i * 4 + 1],
            jit = P[i * 4 + 2],
            sd = P[i * 4 + 3];
          const c = Math.cos(phi),
            s = Math.sin(phi);
          // radial profile: hot inner edge, long soft tail, fade at the rim
          let b = Math.pow(1.35 / rho, 1.3) * 0.19 * jit;
          b *= rho > 3.6 ? Math.max(0, 1 - (rho - 3.6) / 0.65) : 1;
          // banded texture that drifts with the flow
          b *= 0.7 + 0.3 * Math.sin(rho * 6.0 - t * 0.8 + sd) * Math.sin(phi * 4 + sd * 2);
          // doppler beaming: approaching side (right) brighter
          b *= Math.pow(1 + 0.42 * c, 1.8);
          // project: screen x = rho cos phi, screen y from the camera elevation, far side when s < 0
          const X = rho * c;
          const Y = rho * s * sinE; // near side (s > 0) sits below center on screen
          // lensing: far side gets lifted over the top of the shadow, near side barely bent
          const far = 0.5 * (1 - s); // 0 near side, 1 far side
          const bI = Math.hypot(X, Y);
          const thetaE2 = 0.06 + 1.1 * far * far;
          const bO = 0.5 * (bI + Math.sqrt(bI * bI + 4 * thetaE2));
          const k = bO / Math.max(bI, 1e-4);
          if (s < 0) {
            const [x1, y1] = toCell(X * k, Y * k);
            f.splat(x1, y1, b * Math.min(2.4, 0.6 + k)); // lensing magnifies the far side
          } else {
            near.push(X * k, Y * k, b);
          }
          // secondary image: light that went round the far side, a thin mirrored arc hugging the shadow
          const k2 = (0.5 * (bI + Math.sqrt(bI * bI + 4 * 1.25))) / Math.max(bI, 1e-4);
          near.push(X * k2 * 0.98, -Y * k2, b * 0.16);
        }
        // the shadow: nothing behind the hole escapes r < 1
        for (let r = 0; r < f.rows; r++) {
          for (let c = 0; c < f.cols; c++) {
            const X = (c + 0.5 - cx) / S;
            const Y = (r + 0.5 - cy) / (S * aspect);
            if (X * X + Y * Y < 1) f.buf[r * f.cols + c] = 0;
          }
        }
        // the near side of the disk passes in front of the shadow
        for (let i = 0; i < near.length; i += 3) {
          const [x, y] = toCell(near[i], near[i + 1]);
          f.splat(x, y, near[i + 2]);
        }
      },
    };
  }

  /* ---------------------------------------------------------------- lorenz */

  function rk4(state, deriv, h) {
    const n = state.length;
    const k1 = deriv(state);
    const s2 = new Float64Array(n);
    for (let i = 0; i < n; i++) s2[i] = state[i] + 0.5 * h * k1[i];
    const k2 = deriv(s2);
    const s3 = new Float64Array(n);
    for (let i = 0; i < n; i++) s3[i] = state[i] + 0.5 * h * k2[i];
    const k3 = deriv(s3);
    const s4 = new Float64Array(n);
    for (let i = 0; i < n; i++) s4[i] = state[i] + h * k3[i];
    const k4 = deriv(s4);
    for (let i = 0; i < n; i++) state[i] += (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }

  function lorenz() {
    const sigma = 10,
      rho = 28,
      beta = 8 / 3;
    const deriv = (s) => [sigma * (s[1] - s[0]), s[0] * (rho - s[2]) - s[1], s[0] * s[1] - beta * s[2]];
    const TR = 3,
      LEN = 2600;
    const states = [],
      trails = [];
    for (let k = 0; k < TR; k++) {
      states.push(new Float64Array([0.1 + k * 0.001, 0, 20 + k]));
      trails.push({ buf: new Float32Array(LEN * 3), head: 0, n: 0 });
    }
    // warm up so trails start on the attractor
    for (let k = 0; k < TR; k++) for (let i = 0; i < 2000; i++) rk4(states[k], deriv, 0.005);
    let S = 1,
      cx = 0,
      cy = 0,
      aspect = 1;
    return {
      stars: false,
      layout(f) {
        aspect = f.cw / f.ch;
        S = Math.min(f.cols / 60, (f.rows * 0.92) / (aspect * 0.9 * 52));
        cx = f.cols * 0.5;
        cy = f.rows * 0.5;
      },
      update(f, dt) {
        const steps = REDUCED ? 1400 : Math.max(1, Math.round(dt * 160));
        for (let k = 0; k < TR; k++) {
          const st = states[k],
            tr = trails[k];
          for (let i = 0; i < steps; i++) {
            rk4(st, deriv, 0.005);
            const h = tr.head;
            tr.buf[h * 3] = st[0];
            tr.buf[h * 3 + 1] = st[1];
            tr.buf[h * 3 + 2] = st[2];
            tr.head = (h + 1) % LEN;
            tr.n = Math.min(LEN, tr.n + 1);
          }
        }
      },
      draw(f) {
        const a = Math.PI / 2 + 0.45 * Math.sin(f.t * 0.1); // sway around the y–z view, the wide butterfly
        const ca = Math.cos(a),
          sa = Math.sin(a);
        for (let k = 0; k < TR; k++) {
          const tr = trails[k];
          for (let i = 0; i < tr.n; i++) {
            const idx = (tr.head - 1 - i + LEN * 2) % LEN;
            const x = tr.buf[idx * 3],
              y = tr.buf[idx * 3 + 1],
              z = tr.buf[idx * 3 + 2] - 25;
            const xr = x * ca - y * sa;
            const yr = x * sa + y * ca;
            const depth = 0.75 + 0.25 * (yr / 30);
            const age = 1 - i / tr.n;
            const b = (0.14 + 0.75 * age) * depth;
            f.splat(cx + xr * S, cy - z * S * aspect * 0.9, b);
          }
        }
      },
    };
  }

  /* ------------------------------------------------------- double pendulum */

  function pendulum() {
    const g = 9.81,
      m1 = 1,
      m2 = 1,
      l1 = 1,
      l2 = 1;
    const deriv = (s) => {
      const [t1, w1, t2, w2] = s;
      const d = t1 - t2;
      const den = 2 * m1 + m2 - m2 * Math.cos(2 * d);
      const a1 =
        (-g * (2 * m1 + m2) * Math.sin(t1) - m2 * g * Math.sin(t1 - 2 * t2) - 2 * Math.sin(d) * m2 * (w2 * w2 * l2 + w1 * w1 * l1 * Math.cos(d))) /
        (l1 * den);
      const a2 = (2 * Math.sin(d) * (w1 * w1 * l1 * (m1 + m2) + g * (m1 + m2) * Math.cos(t1) + w2 * w2 * l2 * m2 * Math.cos(d))) / (l2 * den);
      return [w1, a1, w2, a2];
    };
    const K = 3,
      LEN = 380;
    const states = [],
      trails = [];
    for (let k = 0; k < K; k++) {
      states.push(new Float64Array([Math.PI * 0.72 + k * 0.0012, 0, Math.PI * 0.9, 0]));
      trails.push({ buf: new Float32Array(LEN * 2), head: 0, n: 0 });
    }
    let S = 1,
      cx = 0,
      cy = 0,
      aspect = 1;
    return {
      stars: false,
      layout(f) {
        aspect = f.cw / f.ch;
        S = Math.min(f.cols / 4.6, (f.rows * 0.86) / (aspect * 2.05));
        cx = f.cols * 0.5;
        cy = f.rows * 0.07;
      },
      update(f, dt) {
        const steps = REDUCED ? 600 : Math.max(1, Math.round(dt * 240));
        for (let k = 0; k < K; k++) {
          const st = states[k],
            tr = trails[k];
          for (let i = 0; i < steps; i++) {
            rk4(st, deriv, 1 / 240);
            const x2 = Math.sin(st[0]) * l1 + Math.sin(st[2]) * l2;
            const y2 = Math.cos(st[0]) * l1 + Math.cos(st[2]) * l2;
            const h = tr.head;
            tr.buf[h * 2] = x2;
            tr.buf[h * 2 + 1] = y2;
            tr.head = (h + 1) % LEN;
            tr.n = Math.min(LEN, tr.n + 1);
          }
        }
      },
      draw(f) {
        const toCell = (x, y) => [cx + x * S, cy + y * S * aspect];
        for (let k = 0; k < K; k++) {
          const tr = trails[k];
          for (let i = 0; i < tr.n; i += 2) {
            const idx = (tr.head - 1 - i + LEN * 2) % LEN;
            const age = 1 - i / tr.n;
            const [x, y] = toCell(tr.buf[idx * 2], tr.buf[idx * 2 + 1]);
            f.splat(x, y, 0.04 + 0.5 * age * age);
          }
          // rods for the lead pendulum only, as a faint line of points
          if (k === 0) {
            const st = states[0];
            const p1 = [Math.sin(st[0]) * l1, Math.cos(st[0]) * l1];
            const p2 = [p1[0] + Math.sin(st[2]) * l2, p1[1] + Math.cos(st[2]) * l2];
            const seg = (ax, ay, bx, by) => {
              for (let s = 0; s <= 1; s += 0.03) {
                const [x, y] = toCell(ax + (bx - ax) * s, ay + (by - ay) * s);
                f.splat(x, y, 0.35);
              }
            };
            seg(0, 0, p1[0], p1[1]);
            seg(p1[0], p1[1], p2[0], p2[1]);
            const [bx, by] = toCell(p2[0], p2[1]);
            f.splat(bx, by, 1.2);
            const [ax, ay] = toCell(p1[0], p1[1]);
            f.splat(ax, ay, 1.0);
          }
        }
      },
    };
  }

  /* ------------------------------------------------------------------ boot */

  const SCENES = { blackhole, lorenz, pendulum };

  function boot() {
    document.querySelectorAll("canvas[data-scene]").forEach((canvas) => {
      const make = SCENES[canvas.dataset.scene];
      if (!make) return;
      const field = new Field(canvas, make(), { fontPx: Number(canvas.dataset.font) || 13 });
      const counter = canvas.dataset.counter ? document.querySelector(canvas.dataset.counter) : null;
      if (counter) {
        let lastN = -1;
        field.onPaint = (n) => {
          const q = Math.round(n / 25) * 25;
          if (q !== lastN) {
            lastN = q;
            counter.textContent = q.toLocaleString("en-US");
          }
        };
      }
      if (document.fonts && document.fonts.load) {
        document.fonts.load(`${field.fontPx}px "Geist Mono"`).then(
          () => field.resize(),
          () => {}
        );
      }
      field.start();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
