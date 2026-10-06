import * as THREE from "three/webgpu";
import { Signaling } from "./signaling";
import { buildSource, makeClockMap } from "./audio/source";
import { loadWorklets } from "./audio/worklets";
import type { Transport } from "./transports/types";
import { WebRTCMesh } from "./transports/webrtc-mesh";
import { WsRelay } from "./transports/ws-relay";
import { WtDatagram } from "./transports/wt-datagram";
import { MoqTransport } from "./transports/moq";

// three.js WebGPU 3D world client: a real VC client (same signaling + transport
// stack as the headless bench client) that renders avatars in a scene and moves
// with WASD. Peer positions arrive over the game WS as {pos:[x,z]} signals;
// voice attenuation is computed client-side: full inside HEAR_REF, linear
// fade to silence at HEAR_MAX (see constants below).

// Spatial rolloff: full volume inside HEAR_REF, linear fade to silence at
// HEAR_MAX. Inverse-distance curves never reach 0 (30/d keeps ~0.26 at 100u)
// which reads as "no attenuation" perceptually — a finite cutoff is clearer.
const HEAR_REF = 15; // gain = 1 within this radius
const HEAR_MAX = 90; // gain = 0 beyond this radius
const SPEED = 14; // units/s

const transports: Record<string, () => Transport> = {
  "webrtc-mesh": () => new WebRTCMesh(),
  "ws-relay": () => new WsRelay(),
  "wt-datagram": () => new WtDatagram(),
  moq: () => new MoqTransport(),
};

function labelSprite(text: string): THREE.Sprite {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 64;
  const g = cv.getContext("2d")!;
  const tex = new THREE.CanvasTexture(cv);
  const draw = (t: string) => {
    g.clearRect(0, 0, 256, 64);
    g.font = "bold 30px monospace";
    g.textAlign = "center";
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(0, 0, 256, 64);
    g.fillStyle = "#fff";
    g.fillText(t, 128, 42);
    tex.needsUpdate = true;
  };
  draw(text);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  sp.scale.set(10, 2.5, 1);
  (sp as unknown as Record<string, unknown>).setText = draw;
  return sp;
}

function makeAvatar(id: string, self: boolean): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(1, 2.2, 6, 12),
    new THREE.MeshStandardMaterial({ color: self ? 0x58a6ff : 0xf0883e }),
  );
  body.position.y = 2.2;
  g.add(body);
  const label = labelSprite(id.split("-").pop() ?? id);
  label.position.y = 5.6;
  g.add(label);
  g.userData.label = label;
  g.userData.name = id.split("-").pop() ?? id;
  // speech ring: scales/pulses with this peer's audio level
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.4, 1.8, 40),
    new THREE.MeshBasicMaterial({ color: 0x3fb950, transparent: true, opacity: 0.0, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  g.add(ring);
  g.userData.ring = ring;
  return g;
}

async function main() {
  const p = new URLSearchParams(location.search);
  // __VC_CFG: server-baked defaults (lobby page serves the world with no
  // params); URL params still win when present (harness passes explicit ones).
  const cfg = ((window as any).__VC_CFG ?? {}) as {
    server?: string; transport?: string; media?: string; wthash?: string;
  };
  const server = p.get("server") ?? cfg.server!;
  const room = p.get("room")!;
  const transportName = p.get("transport") ?? cfg.transport ?? "moq";
  const index = Number(p.get("index") ?? 0);
  const perRoom = Number(p.get("perRoom") ?? 3);
  const navStart = performance.now();
  const hud = document.getElementById("hud")!;
  // debug overlay: `?debug=1` or backquote toggles; refreshed by the stats loop
  const dbgEl = document.getElementById("dbg")!;
  let dbgOn = p.get("debug") === "1";
  dbgEl.style.display = dbgOn ? "block" : "none";
  let lastSigRtt: number | undefined;
  let dbgFrames = 0;

  const pending: unknown[] = [];
  const report = (kind: string, data: Record<string, unknown>) => {
    pending.push({ ts: Date.now(), client: id, room, transport: transportName, kind, data });
  };
  setInterval(() => {
    if (pending.length && (window as any).__report) (window as any).__report(pending.splice(0));
  }, 1000);

  // ---------- renderer (WebGPU via three/webgpu; falls back to WebGL2 backend) ----------
  // ?gl=1 forces the WebGL2 backend — headless Chromium has no working WebGPU
  // device, but the scene/TSL code is identical either way.
  const renderer = new THREE.WebGPURenderer({ antialias: true, forceWebGL: p.get("gl") === "1" });
  await renderer.init();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(devicePixelRatio);
  document.body.appendChild(renderer.domElement);
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? "WebGPU" : "WebGL2";
  addEventListener("resize", () => renderer.setSize(innerWidth, innerHeight));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.Fog(0x0b0e14, 90, 240);
  scene.add(new THREE.HemisphereLight(0xbcc8e0, 0x1a2030, 1.1));
  const sun = new THREE.DirectionalLight(0xfff0d0, 1.6);
  sun.position.set(40, 70, 20);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x11151d }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE.GridHelper(400, 40, 0x2b3242, 0x1a2030);
  (grid.position as THREE.Vector3).y = 0.02;
  scene.add(grid);

  // scattered blocks for depth cues
  const boxGeo = new THREE.BoxGeometry(4, 4, 4);
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x223048 });
  for (const [bx, bz] of [[-30, 20], [45, -35], [-55, -50], [30, 55], [70, 10]] as const) {
    const b = new THREE.Mesh(boxGeo, boxMat);
    b.position.set(bx, 2, bz);
    b.rotation.y = (bx * 13 + bz * 7) % 1.5;
    scene.add(b);
  }

  // hearing rings around the local player: inner = full volume, outer = edge
  // of audibility (gain hits 0)
  const hearRing = new THREE.Mesh(
    new THREE.RingGeometry(HEAR_REF - 0.2, HEAR_REF, 64),
    new THREE.MeshBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
  );
  hearRing.rotation.x = -Math.PI / 2;
  hearRing.position.y = 0.05;
  scene.add(hearRing);
  const edgeRing = new THREE.Mesh(
    new THREE.RingGeometry(HEAR_MAX - 0.4, HEAR_MAX, 96),
    new THREE.MeshBasicMaterial({ color: 0x2f81f7, transparent: true, opacity: 0.12, side: THREE.DoubleSide }),
  );
  edgeRing.rotation.x = -Math.PI / 2;
  edgeRing.position.y = 0.04;
  scene.add(edgeRing);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
  const camMode = p.get("cam") ?? "follow";

  // ---------- avatars ----------
  const avatars = new Map<string, THREE.Group>();
  const addAvatar = (aid: string, self: boolean) => {
    const a = makeAvatar(aid, self);
    scene.add(a);
    avatars.set(aid, a);
    return a;
  };
  let me: THREE.Group;

  // ---------- input / movement ----------
  const keys = new Set<string>();
  addEventListener("keydown", (e) => keys.add(e.code));
  addEventListener("keyup", (e) => keys.delete(e.code));
  let yaw = 0;
  let orbitYaw = 0, orbitPitch = 0.42;
  let dragging = false, lastX = 0, lastY = 0;
  addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  addEventListener("mouseup", () => (dragging = false));
  addEventListener("mousemove", (e) => {
    if (!dragging) return;
    orbitYaw -= (e.clientX - lastX) * 0.005;
    orbitPitch = Math.min(1.4, Math.max(0.15, orbitPitch + (e.clientY - lastY) * 0.004));
    lastX = e.clientX; lastY = e.clientY;
  });

  const posParam = (p.get("pos") ?? "").split(",").map(Number);
  // no explicit pos → random spawn on a ring so auto-joiners don't stack at 0,0
  const pos = new THREE.Vector3(
    posParam.length === 2 && posParam.every(Number.isFinite) ? posParam[0] : (Math.random() - 0.5) * 24,
    0,
    posParam.length === 2 && posParam.every(Number.isFinite) ? posParam[1] : (Math.random() - 0.5) * 24,
  );

  // autopilot waypoint route for recorded demos (?auto=1)
  let waypoints: number[][] = [];
  if (p.get("auto") === "1" && p.get("path")) {
    waypoints = p.get("path")!.split(";").map((w) => w.split(",").map(Number));
  }
  let wpIdx = 0;
  (window as any).__moveTo = (x: number, z: number) => { waypoints = [[x, z]]; wpIdx = 0; };

  // ---------- VC stack (same contract as main.ts) ----------
  const recChunks = new Map<string, Float32Array[]>();
  const record = p.get("record") === "1";
  const pushRec = (peer: string, f32: Float32Array) => {
    let a = recChunks.get(peer);
    if (!a) { a = []; recChunks.set(peer, a); }
    a.push(f32);
  };
  (window as any).__drainRec = () => {
    const out: Record<string, string> = {};
    for (const [peer, chunks] of recChunks) {
      const total = chunks.reduce((n2, c2) => n2 + c2.length, 0);
      if (!total) continue;
      const f = new Float32Array(total);
      let o = 0;
      for (const c2 of chunks) { f.set(c2, o); o += c2.length; }
      chunks.length = 0;
      const u8 = new Uint8Array(f.buffer);
      let bin = "";
      for (let i = 0; i < u8.length; i += 8192)
        bin += String.fromCharCode(...u8.subarray(i, i + 8192));
      out[peer] = btoa(bin);
    }
    return out;
  };

  const peerGains = new Map<string, number>();
  (window as any).__gains = peerGains;

  // join gate: real browsers hold AudioContext + getUserMedia behind a user
  // gesture, so humans click "join voice"; ?autojoin=1 / ?auto=1 skip it
  const gate = document.getElementById("gate");
  if (gate && p.get("autojoin") !== "1" && p.get("auto") !== "1") {
    gate.style.display = "flex";
    await new Promise<void>((res) =>
      gate.addEventListener("click", () => { gate.style.display = "none"; res(); }, { once: true }));
  }

  // identity: ?id&?token pins it (harness/demos), or auto-join — the client
  // POSTs /v1/join on the same service and gets a roster-unique id + its JWT.
  // This is the "walk in and you're in" path: open the URL, click join, done.
  let id = p.get("id");
  let token = p.get("token");
  if (!id || !token) {
    const api = server.replace(/^ws/, "http");
    const r = await fetch(`${api}/v1/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room, name: p.get("name") ?? undefined }),
    });
    if (!r.ok) throw new Error(`join failed: ${r.status} ${await r.text()}`);
    const j = (await r.json()) as { id: string; token: string };
    if (!j.id || !j.token) throw new Error("join: bad response");
    id = j.id;
    token = j.token;
  }
  me = addAvatar(id, true);

  // voice source: mic is the default for humans (this is a real VC client).
  // ?voice=<url> plays a looped wav instead, ?voice=mic forces mic explicitly,
  // ?nomic=1 opts out back to the carrier. Markers are for bench measurement
  // only — off when a real voice source is present unless ?markers=1.
  const voiceParam = p.get("voice");
  const micOn = voiceParam === "mic" || (!voiceParam && p.get("nomic") !== "1");
  const voiceUrl = micOn ? undefined : voiceParam ?? undefined;

  const ctx = new AudioContext({ sampleRate: 48000 });
  await ctx.resume();
  await loadWorklets(ctx);
  const clock = makeClockMap(ctx);
  const audio = await buildSource(ctx, index, perRoom, (epochMs) =>
    report("marker-sent", { epoch_ms: epochMs }),
    clock, {
      pcmTap: true,
      voiceUrl,
      mic: micOn,
      markers: p.get("markers") != null ? p.get("markers") === "1" : !(voiceUrl || micOn),
    });
  // speaker bus: decoded remote audio renders here audibly; N/button deafens it
  const spk = ctx.createGain();
  spk.connect(ctx.destination);
  const onDetected = (peer: string, epochMs: number) =>
    report("marker-detected", { peer, epoch_ms: epochMs });
  if (record) audio.onPcm((f) => pushRec("self", f));

  const transport = transports[transportName]();
  const sig = new Signaling(`${server}/v1/signaling?token=${encodeURIComponent(token)}`);
  await sig.ready;
  const peers = await new Promise<string[]>((res) => {
    sig.onMsg = (m) => {
      if (m.type === "peers") res(m.peers.map((x) => x.id));
      else transport.handleMsg?.(m);
    };
  });
  report("join", { joined_ms: performance.now() - navStart, peers: peers.length });

  const roster = new Set(peers);
  const peerPos = new Map<string, number[]>();
  const peerMutes = new Map<string, boolean>();
  sig.onMsg = (m) => {
    if (m.type === "pong") { lastSigRtt = performance.now() - m.t; report("ctrl-rtt", { rtt_ms: lastSigRtt }); }
    else if (m.type === "peer-joined") {
      roster.add(m.id); transport.handleMsg?.(m);
      if (!avatars.has(m.id)) addAvatar(m.id, false);
    } else if (m.type === "peer-left") {
      roster.delete(m.id); peerPos.delete(m.id); transport.handleMsg?.(m);
      const a = avatars.get(m.id);
      if (a) { scene.remove(a); avatars.delete(m.id); }
    } else if (m.type === "signal" && Array.isArray((m.data as { pos?: number[] })?.pos)) {
      const d = m.data as { pos: number[]; mute?: number };
      peerPos.set(m.from, d.pos);
      const mu = d.mute === 1;
      if (mu !== (peerMutes.get(m.from) ?? false)) {
        peerMutes.set(m.from, mu);
        const a = avatars.get(m.from);
        const lbl = a?.userData.label as Record<string, unknown> | undefined;
        (lbl?.setText as ((t: string) => void) | undefined)
          ?.(`${a!.userData.name}${mu ? "·muted" : ""}`);
      }
      if (!avatars.has(m.from)) addAvatar(m.from, false);
    } else transport.handleMsg?.(m);
  };
  for (const peer of peers) if (!avatars.has(peer)) addAvatar(peer, false);

  await transport.start({
    id, room, peers, sig, audio, ctx, clock, report, onDetected,
    record, gains: peerGains, onRecvPcm: record ? pushRec : undefined,
    play: spk,
    token,
    media: p.get("media") ?? cfg.media,
    wtHash: p.get("wthash") ?? cfg.wthash,
    moqMaxAge: p.get("moqmaxage") != null ? Number(p.get("moqmaxage")) : undefined,
    moqAuth: p.get("moqauth") !== "0",
    frameDurMs: p.get("framedur") != null ? Number(p.get("framedur")) : undefined,
    latMode: p.get("latmode") ?? undefined,
    detJs: p.get("detjs") === "1",
  });

  setInterval(() => sig.send({ type: "ping", t: performance.now() }), 1000);

  // ---------- mic / speaker mute (M / N keys or the on-screen buttons) ----------
  const mutebar = document.getElementById("mutebar");
  if (mutebar) mutebar.style.display = "flex";
  const bMic = document.getElementById("bmic");
  const bSpk = document.getElementById("bspk");
  let micMuted = false, spkMuted = false;
  const syncMuteUi = () => {
    if (bMic) {
      bMic.textContent = micMuted ? "mic: MUTED [M]" : `mic: ${audio.mode} [M]`;
      bMic.style.color = micMuted ? "#f85149" : "#3fb950";
    }
    if (bSpk) {
      bSpk.textContent = spkMuted ? "hear: MUTED [N]" : "hear: on [N]";
      bSpk.style.color = spkMuted ? "#f85149" : "#3fb950";
    }
  };
  const setMicMuted = (m: boolean) => { micMuted = m; audio.setMuted(m); syncMuteUi(); };
  const setSpkMuted = (m: boolean) => { spkMuted = m; spk.gain.value = m ? 0 : 1; syncMuteUi(); };
  bMic?.addEventListener("click", () => setMicMuted(!micMuted));
  bSpk?.addEventListener("click", () => setSpkMuted(!spkMuted));
  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "KeyM") setMicMuted(!micMuted);
    else if (e.code === "KeyN") setSpkMuted(!spkMuted);
    else if (e.code === "Backquote") { dbgOn = !dbgOn; dbgEl.style.display = dbgOn ? "block" : "none"; }
  });
  (window as any).__setMicMuted = setMicMuted;
  (window as any).__setSpkMuted = setSpkMuted;
  (window as any).__muteState = () => ({ mic: audio.mode, micMuted, spkMuted });
  setInterval(syncMuteUi, 1000); // label tracks the async mic upgrade
  syncMuteUi();

  // position broadcast over the game channel (+ mic-mute flag for peers' UIs)
  setInterval(() => {
    const data = { pos: [pos.x, pos.z], mute: micMuted ? 1 : 0 };
    for (const peer of roster) sig.send({ type: "signal", to: peer, data });
  }, 100);

  const levels = new Map<string, number>();
  const fmtk = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  let prevRow = { sent_frames: 0, recv_frames: 0, recv_bytes: 0 };
  let lastDbgFrames = 0;
  const renderDbg = (rows: Record<string, unknown>[], row0: Record<string, unknown>) => {
    const sent = (row0.sent_frames as number) ?? 0;
    const recv = (row0.recv_frames as number) ?? 0;
    const bytes = (row0.recv_bytes as number) ?? 0;
    const fpsNow = (dbgFrames - lastDbgFrames) * 4; // 250ms tick → /s
    lastDbgFrames = dbgFrames;
    const sRate = (sent - prevRow.sent_frames) * 4;
    const rRate = (recv - prevRow.recv_frames) * 4;
    const kbps = ((bytes - prevRow.recv_bytes) * 8) / 1000 * 4;
    prevRow = { sent_frames: sent, recv_frames: recv, recv_bytes: bytes };
    const lat = (row0.lat_ms ?? {}) as Record<string, number>;
    const lv = (row0.levels ?? {}) as Record<string, number>;
    const lines = [
      `${transportName} · ${room} · ${id} · audio=${audio.mode}${micMuted ? " MUTED" : ""}${spkMuted ? " deaf" : ""}`,
      `sig ${lastSigRtt != null ? `${lastSigRtt.toFixed(0)}ms` : "-"} · fps ${fpsNow.toFixed(0)} · peers ${roster.size}`,
      `sent ${fmtk(sent)} +${sRate}/s · recv ${fmtk(recv)} +${rRate}/s · ${kbps.toFixed(0)} kb/s`,
    ];
    if (row0.dec_fed != null) lines.push(`dec fed ${fmtk(row0.dec_fed as number)} queue ${row0.dec_queue}`);
    if (row0.dgram_latency_p50 != null) lines.push(`dgram p50 ${row0.dgram_latency_p50}ms max ${row0.dgram_latency_max}ms`);
    if (transportName === "webrtc-mesh") {
      if (rows.some((r) => r.peer != null)) {
        lines.push("peer        rtt  jit lost");
        for (const r of rows) if (r.peer != null)
          lines.push(`${String(r.peer).padEnd(11)} ${String(r.rtt_ms).padStart(4)} ${String(r.jitter_ms).padStart(4)} ${String(r.packets_lost).padStart(4)}`);
      }
    } else if (roster.size) {
      lines.push("peer        dist  gain   lat   lvl");
      for (const peer of roster) {
        const pp = peerPos.get(peer);
        const dist = pp ? Math.hypot(pp[0] - pos.x, pp[1] - pos.z) : NaN;
        lines.push(
          `${peer.slice(0, 11).padEnd(11)} ` +
          `${(Number.isNaN(dist) ? "-" : dist.toFixed(1)).padStart(5)} ` +
          `${(peerGains.get(peer) ?? 0).toFixed(2).padStart(5)} ` +
          `${String(lat[peer] ?? "-").padStart(5)} ` +
          `${(lv[peer] ?? 0).toFixed(2).padStart(5)}`,
        );
      }
    }
    dbgEl.textContent = lines.join("\n");
  };
  setInterval(async () => {
    try {
      const rows = await transport.stats();
      const row0 = rows[0] ?? {};
      for (const [peer, lv] of Object.entries((row0.levels ?? {}) as Record<string, number>))
        levels.set(peer, lv);
      (window as any).__state = { id, room, transport: transportName, peers: [...roster], stats: rows, ts: Date.now(), pos: [pos.x, pos.z] };
      if (dbgOn) renderDbg(rows, row0);
      for (const s of rows) report(transportName === "webrtc-mesh" ? "rtc" : "media", s);
    } catch {}
  }, 250);
  (window as any).__report?.([{ ts: Date.now(), client: id, room, transport: transportName, kind: "ready", data: {} }]);

  // ---------- frame loop ----------
  // ?fps=N caps the render rate — headless recording on a loaded machine
  // starves the decode pipeline if the page renders unthrottled
  const fpsCap = Number(p.get("fps") ?? 0) || 0;
  const frameBudget = fpsCap ? 1000 / fpsCap : 0;
  let lastRender = 0;
  const clockT = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    if (frameBudget) {
      const now = performance.now();
      if (now - lastRender < frameBudget) return;
      lastRender = now;
    }
    dbgFrames++;
    const dt = Math.min(0.05, clockT.getDelta());
    // movement (WASD relative to yaw, QE rotates)
    if (keys.has("KeyQ")) yaw += dt * 2.2;
    if (keys.has("KeyE")) yaw -= dt * 2.2;
    const fwd = (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const str = (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) - (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
    if (fwd || str) {
      const s = SPEED * dt;
      pos.x += (Math.sin(yaw) * -fwd + Math.cos(yaw) * str) * s;
      pos.z += (Math.cos(yaw) * -fwd - Math.sin(yaw) * str) * s;
    }
    if (waypoints.length) {
      const [tx, tz] = waypoints[wpIdx % waypoints.length];
      const dx = tx - pos.x, dz = tz - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.2) wpIdx++;
      else {
        const s = Math.min(d, SPEED * dt);
        pos.x += (dx / d) * s;
        pos.z += (dz / d) * s;
        yaw = Math.atan2(-dx, -dz);
      }
    }
    me.position.set(pos.x, 0, pos.z);
    me.rotation.y = yaw;
    hearRing.position.set(pos.x, 0.05, pos.z);
    edgeRing.position.set(pos.x, 0.04, pos.z);

    // remote avatars glide toward last reported position
    for (const [peer, a] of avatars) {
      if (peer === id) continue;
      const pp = peerPos.get(peer);
      if (pp) {
        a.position.x += (pp[0] - a.position.x) * Math.min(1, dt * 8);
        a.position.z += (pp[1] - a.position.z) * Math.min(1, dt * 8);
      }
      const ring = a.userData.ring as THREE.Mesh;
      const lv = levels.get(peer) ?? 0;
      (ring.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, lv * 6);
      const sc = 1 + Math.min(2.5, lv * 18);
      ring.scale.set(sc, sc, 1);
    }

    // spatial gain -> transport attenuation (linear rolloff to silence)
    for (const [peer, a] of avatars) {
      if (peer === id) continue;
      const d = Math.hypot(a.position.x - pos.x, a.position.z - pos.z);
      peerGains.set(peer, Math.min(1, Math.max(0, (HEAR_MAX - d) / (HEAR_MAX - HEAR_REF))));
    }

    // camera
    if (camMode === "top") {
      camera.position.set(0, 150, 60);
      camera.lookAt(0, 0, 0);
    } else {
      const cd = 34;
      const cx = pos.x + Math.sin(orbitYaw) * Math.cos(orbitPitch) * cd;
      const cz = pos.z + Math.cos(orbitYaw) * Math.cos(orbitPitch) * cd;
      const cy = Math.sin(orbitPitch) * cd + 3;
      camera.position.set(cx, cy, cz);
      camera.lookAt(pos.x, 3, pos.z);
    }
    renderer.render(scene, camera);
  });

  // HUD
  setInterval(() => {
    let t = `${id} · room ${room} · ${transportName} · ${backend}\npos ${pos.x.toFixed(1)}, ${pos.z.toFixed(1)} · peers ${roster.size}` +
      ` · mic=${audio.mode}${micMuted ? "(MUTED)" : ""} hear=${spkMuted ? "MUTED" : "on"}`;
    for (const peer of roster) {
      const a = avatars.get(peer);
      const d = a ? Math.hypot(a.position.x - pos.x, a.position.z - pos.z) : NaN;
      const g = peerGains.get(peer) ?? 0;
      const lv = levels.get(peer) ?? 0;
      const bar = "█".repeat(Math.round(lv * 40)).padEnd(12, "·");
      t += `\n← ${peer.padEnd(14)} d=${isNaN(d) ? "??" : d.toFixed(0).padStart(3)} gain=${g.toFixed(2)} ${bar} ${lv.toFixed(3)}${peerMutes.get(peer) ? " ·mut" : ""}`;
    }
    hud.textContent = t;
  }, 150);
}

main().catch((e) => {
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `error: ${e}`;
  console.error(e);
});
