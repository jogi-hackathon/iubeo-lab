import type { ClockMap } from "./source";

const SR = 48000;

export type Detector = {
  node: AudioWorkletNode;
  feed(pcm: Float32Array): void;
  level: number;
  gain: number; // spatial attenuation applied to inbound audio
  onpcm?: (pcm: Float32Array) => void; // recording tap (rec: true)
};

// Wire a remote MediaStream (WebRTC path) into a detector worklet.
// Headless Chromium only decodes inbound RTC audio when a media element renders it,
// so we also attach a muted <audio> as a decode pump.
export function attachStreamDetector(
  ctx: AudioContext,
  stream: MediaStream,
  onMarker: (ctxTime: number) => void,
  rec = false,
  playTo?: AudioNode,
): Detector {
  const el = document.createElement("audio");
  el.srcObject = stream;
  el.muted = true;
  el.style.display = "none";
  document.body.appendChild(el);
  el.play().catch(() => {});

  const src = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  const node = new AudioWorkletNode(ctx, "detector", {
    processorOptions: { freq: 3000, rec },
  });
  // audible path (real VC): same spatial gain drives what reaches the speaker
  let spk: GainNode | undefined;
  if (playTo) {
    spk = ctx.createGain();
    src.connect(spk);
    spk.connect(playTo);
  }
  const det: Detector = { node, feed: () => {}, level: 0, gain: 1 };
  Object.defineProperty(det, "gain", {
    get: () => gainNode.gain.value,
    set: (v: number) => { gainNode.gain.value = v; if (spk) spk.gain.value = v; },
  });
  node.port.onmessage = (e) => {
    if (e.data?.kind === "marker") onMarker(e.data.ctxTime);
    else if (e.data?.kind === "level") det.level = e.data.rms;
    else if (e.data?.kind === "pcm") det.onpcm?.(e.data.pcm);
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(gainNode);
  gainNode.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination); // keep the graph pulling; inaudible
  return det;
}

// Feed-mode detector for decoded PCM from relay transports (WS/WT/MoQ).
// playTo: render decoded audio audibly — chunks are scheduled on the WebAudio
// clock, which doubles as the jitter buffer (30ms lookahead; a >500ms buildup
// or an underrun re-anchors at the live edge).
export function createFeedDetector(
  ctx: AudioContext,
  onMarker: (ctxTime: number) => void,
  rec = false,
  playTo?: AudioNode,
): Detector {
  const node = new AudioWorkletNode(ctx, "detector", {
    processorOptions: { freq: 3000, rec },
  });
  let spk: GainNode | undefined;
  let nextT = 0;
  if (playTo) {
    spk = ctx.createGain();
    spk.connect(playTo);
    nextT = ctx.currentTime + 0.03;
  }
  const det: Detector = { node, feed: () => {}, level: 0, gain: 1 };
  det.feed = (pcm) => {
    const g = det.gain;
    if (g < 1) for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
    node.port.postMessage(pcm);
    if (spk && pcm.length) {
      const buf = ctx.createBuffer(1, pcm.length, SR);
      buf.copyToChannel(pcm, 0);
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(spk);
      const now = ctx.currentTime;
      if (nextT < now + 0.02 || nextT > now + 0.5) nextT = now + 0.03;
      s.start(nextT);
      nextT += pcm.length / SR;
    }
  };
  node.port.onmessage = (e) => {
    if (e.data?.kind === "marker") onMarker(e.data.ctxTime);
    else if (e.data?.kind === "level") det.level = e.data.rms;
    else if (e.data?.kind === "pcm") det.onpcm?.(e.data.pcm);
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(ctx.destination);
  return det;
}

// JS-side Goertzel detector for feed transports: scans decoded PCM the moment
// it arrives instead of waiting for the worklet's 128-sample render quantum.
// Matches the worklet algorithm (same coeff/threshold/eval cadence).
// NOTE: reports in ctxTime domain (ctx.currentTime read at detection) because
// marker-sent epochs are recorded in that domain — mixing Date.now() would
// subtract the AudioContext output latency and skew the diff negative.
export function createJsDetector(
  ctx: BaseAudioContext,
  onMarker: (ctxTime: number) => void,
): (pcm: Float32Array) => void {
  const coeff = 2 * Math.cos((2 * Math.PI * 3000) / 48000);
  const thresh = 0.015;
  let above = false, cooldownUntil = 0;
  return (pcm) => {
    const n = pcm.length;
    const tNow = ctx.currentTime;
    // per-chunk Goertzel state, same as the worklet's scan(): the resonator is
    // undamped, so state carried across chunks rings forever and pins `above`.
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s = pcm[i] + coeff * s1 - s2;
      s2 = s1; s1 = s;
      if (((i + 1) & 31) === 0 || i === n - 1) {
        const p = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (32 * 32);
        const t = tNow - (n - 1 - i) / 48000;
        if (!above && p > thresh && t >= cooldownUntil) {
          above = true;
          cooldownUntil = t + 0.8;
          onMarker(t);
          break;
        } else if (p < thresh * 0.3) above = false;
      }
    }
  };
}

export function onMarkerReport(
  clock: ClockMap,
  peerId: string,
  cb: (peer: string, epochMs: number) => void,
) {
  return (ctxTime: number) => cb(peerId, clock.toEpoch(ctxTime));
}
