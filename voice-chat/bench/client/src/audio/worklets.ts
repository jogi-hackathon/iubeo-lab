// AudioWorklet sources, loaded via Blob URL (esbuild can't emit worklet files).

export const CAPTURE_WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const chunk = (options.processorOptions && options.processorOptions.chunk) || 480;
    this.buf = new Float32Array(chunk); // default 480 = 10ms chunks, not per-128-block
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const n = Math.min(ch.length - i, this.buf.length - this.len);
        this.buf.set(ch.subarray(i, i + n), this.len);
        this.len += n;
        i += n;
        if (this.len === this.buf.length) {
          this.port.postMessage(this.buf.slice(0));
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
`;

// Marker detector: per-block Goertzel energy at MARKER_FREQ.
// Modes: input-connected (WebRTC remote stream) or port-fed PCM chunks (decoded relay audio).
export const DETECTOR_WORKLET = `
class Detector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.freq = (options.processorOptions && options.processorOptions.freq) || 3000;
    this.rec = !!(options.processorOptions && options.processorOptions.rec);
    this.coeff = 2 * Math.cos((2 * Math.PI * this.freq) / sampleRate);
    this.thresh = 0.015;
    this.queue = [];
    this.above = false;
    this.cooldownUntil = 0;
    this.sumSq = 0;
    this.nSq = 0;
    this.recBuf = new Float32Array(4800);
    this.recLen = 0;
    this.port.onmessage = (e) => this.queue.push(e.data);
  }
  level(samples, n) {
    // RMS over everything scanned, posted ~every 100ms of audio.
    for (let i = 0; i < n; i++) this.sumSq += samples[i] * samples[i];
    this.nSq += n;
    if (this.nSq >= 4800) {
      this.port.postMessage({ kind: "level", rms: Math.sqrt(this.sumSq / this.nSq) });
      this.sumSq = 0;
      this.nSq = 0;
    }
    // recording tap: stream scanned PCM back ~every 100ms
    if (this.rec) {
      let i = 0;
      while (i < n) {
        const k = Math.min(n - i, this.recBuf.length - this.recLen);
        this.recBuf.set(samples.subarray(i, i + k), this.recLen);
        this.recLen += k;
        i += k;
        if (this.recLen === this.recBuf.length) {
          const b = this.recBuf;
          this.port.postMessage({ kind: "pcm", pcm: b }, [b.buffer]);
          this.recBuf = new Float32Array(4800);
          this.recLen = 0;
        }
      }
    }
  }
  scan(samples, n, baseCtx) {
    this.level(samples, n);
    let s1 = 0, s2 = 0, onset = -1;
    for (let i = 0; i < n; i++) {
      const s = samples[i] + this.coeff * s1 - s2;
      s2 = s1; s1 = s;
      // evaluate power mid-block too for better onset granularity
      if (((i + 1) & 31) === 0 || i === n - 1) {
        const p = (s1 * s1 + s2 * s2 - this.coeff * s1 * s2) / (32 * 32);
        if (!this.above && p > this.thresh && baseCtx >= this.cooldownUntil) {
          this.above = true;
          this.cooldownUntil = baseCtx + 0.8;
          onset = i;
          break;
        } else if (p < this.thresh * 0.3) {
          this.above = false;
        }
      }
    }
    if (onset >= 0) {
      const ctxT = baseCtx - (n - onset - 1) / sampleRate;
      this.port.postMessage({ kind: "marker", ctxTime: ctxT });
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.scan(ch, ch.length, currentTime);
    }
    while (this.queue.length) {
      const c = this.queue.shift();
      this.scan(c, c.length, currentTime);
    }
    return true;
  }
}
registerProcessor("detector", Detector);
`;

export async function loadWorklets(ctx: AudioContext) {
  const blob = new Blob([CAPTURE_WORKLET + "\n" + DETECTOR_WORKLET], {
    type: "application/javascript",
  });
  await ctx.audioWorklet.addModule(URL.createObjectURL(blob));
}
