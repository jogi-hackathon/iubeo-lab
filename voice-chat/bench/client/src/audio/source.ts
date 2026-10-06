// Synthesized deterministic audio source + clock calibration (ctxTime -> epoch ms).
export type ClockMap = { toEpoch(ctxTime: number): number };

export function makeClockMap(ctx: AudioContext): ClockMap {
  // latest calibration sample: (ctxTime, performanceNow)
  let c0 = 0;
  let p0 = 0;
  const calibrate = () => {
    const t = ctx.getOutputTimestamp?.();
    if (t && typeof t.contextTime === "number" && typeof t.performanceTime === "number") {
      c0 = t.contextTime;
      p0 = t.performanceTime;
    } else {
      c0 = ctx.currentTime;
      p0 = performance.now();
    }
  };
  calibrate();
  setInterval(calibrate, 250);
  return { toEpoch: (ct) => performance.timeOrigin + p0 + (ct - c0) * 1000 };
}

export type AudioSource = {
  track: MediaStreamTrack;                       // for WebRTC
  onPcm(cb: (f32: Float32Array) => void): void;  // for encoder-based transports
  markerCtxTimes: number[];                      // scheduled marker ctxTimes
  setMuted(m: boolean): void;                    // mic mute: gate everything sent
  readonly muted: boolean;
  readonly mode: string;                         // carrier | voice | mic | mic-denied
};

export type SourceOpts = { pcmTap: boolean; voiceUrl?: string; mic?: boolean; markers?: boolean; captureChunk?: number };

const MARKER_FREQ = 3000;
const MARKER_DUR_S = 0.06;
const MARKER_PERIOD_MS = 2000;

export async function buildSource(
  ctx: AudioContext,
  index: number,
  perRoom: number,
  onMarkerSent: (epochMs: number) => void,
  clock: ClockMap,
  opts: SourceOpts = { pcmTap: true },
): Promise<AudioSource> {
  // carrier tone (keeps codecs/jitter buffers honest)
  const carrier = ctx.createOscillator();
  carrier.frequency.value = 220;
  const carrierGain = ctx.createGain();
  carrierGain.gain.value = 0.05;
  carrier.connect(carrierGain);

  // marker bus: periodic 3kHz bursts
  const markerGain = ctx.createGain();
  markerGain.gain.value = 0;

  const dest = ctx.createMediaStreamDestination();
  // send gate: every source routes through here so mic-mute silences
  // both the WebRTC track and the PCM tap identically
  const sendGate = ctx.createGain();
  sendGate.connect(dest);
  carrierGain.connect(sendGate);
  markerGain.connect(sendGate);

  // PCM tap for encoder transports (skip entirely when unused — costs a worklet msg flow)
  const cbs: ((f32: Float32Array) => void)[] = [];
  let tap: AudioWorkletNode | undefined;
  if (opts.pcmTap) {
    tap = new AudioWorkletNode(ctx, "capture", {
      processorOptions: { chunk: opts.captureChunk ?? 480 },
    });
    sendGate.connect(tap);
    tap.port.onmessage = (e) => {
      for (const cb of cbs) cb(e.data);
    };
  }

  let mode = "carrier";

  // voice file: looped speech playback mixed over the carrier (demo mode).
  // Failure is non-fatal — the carrier still flows.
  if (opts.voiceUrl) {
    try {
      const buf = await fetch(opts.voiceUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b));
      carrierGain.gain.value = 0; // speech replaces the carrier entirely
      const voiceGain = ctx.createGain();
      voiceGain.gain.value = 0.7;
      voiceGain.connect(sendGate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(voiceGain);
      src.start();
      mode = "voice";
    } catch (e) {
      console.error("[vc] voice load failed:", opts.voiceUrl, e);
    }
  }

  // real mic (VC mode): async upgrade — the carrier keeps flowing until the
  // permission/device resolves, so a denied or pending prompt never stalls
  // page startup. Standard VC constraints (echo cancel, noise suppression, AGC).
  if (opts.mic) {
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    }).then((stream) => {
      const src = ctx.createMediaStreamSource(stream);
      const micGain = ctx.createGain();
      micGain.gain.value = 0.9;
      src.connect(micGain);
      micGain.connect(sendGate);
      carrierGain.gain.value = 0;
      mode = "mic";
    }).catch((e) => {
      mode = "mic-denied";
      console.error("[vc] mic unavailable:", (e as DOMException)?.name ?? e);
    });
  }

  carrier.start();

  // schedule markers: offset = index * (period / perRoom) so peers don't collide
  const markersOn = opts.markers !== false;
  const offsetMs = index * (MARKER_PERIOD_MS / Math.max(perRoom, 1));
  const markerCtxTimes: number[] = [];
  const scheduleMarker = () => {
    const t = ctx.currentTime + 0.1;
    const osc = ctx.createOscillator();
    osc.frequency.value = MARKER_FREQ;
    osc.connect(markerGain);
    markerGain.gain.setValueAtTime(0.5, t);
    osc.start(t);
    osc.stop(t + MARKER_DUR_S);
    markerGain.gain.setValueAtTime(0, t + MARKER_DUR_S);
    markerCtxTimes.push(t);
    onMarkerSent(clock.toEpoch(t));
  };
  const startDelay = MARKER_PERIOD_MS / 2 + offsetMs;
  if (markersOn) {
    setTimeout(() => {
      scheduleMarker();
      setInterval(scheduleMarker, MARKER_PERIOD_MS);
    }, startDelay);
  }

  let muted = false;
  return {
    track: dest.stream.getAudioTracks()[0],
    onPcm(cb) {
      cbs.push(cb);
    },
    markerCtxTimes,
    setMuted(m) {
      muted = m;
      sendGate.gain.value = m ? 0 : 1;
    },
    get muted() { return muted; },
    get mode() { return mode; },
  };
}
