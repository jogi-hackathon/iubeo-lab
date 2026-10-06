// Aggregate metrics.jsonl -> summary.json + console table.
export type RawReport = {
  ts: number;
  client: string;
  room: string;
  transport: string;
  kind: string;
  data: Record<string, unknown>;
};

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}
const statsOf = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] ?? null };
};

export function aggregate(reports: RawReport[], serverRows: any[], warmupUntil: number) {
  const rs = reports.filter((r) => r.ts >= warmupUntil || r.kind === "join");

  const sent = new Map<string, number[]>(); // client -> sorted send epochs
  const detected: { client: string; peer: string; epoch: number }[] = [];
  const ctrlRtt: number[] = [];
  const rtcRtt: number[] = [];
  const rtcJitter: number[] = [];
  const rtcLost: number[] = [];
  const joinMs: number[] = [];
  const mediaLatest = new Map<string, Record<string, unknown>>(); // client -> last cumulative counters
  const errors: unknown[] = [];

  for (const r of rs) {
    const d = r.data;
    switch (r.kind) {
      case "marker-sent":
        (sent.get(r.client) ?? sent.set(r.client, []).get(r.client)!).push(d.epoch_ms as number);
        break;
      case "marker-detected":
        detected.push({ client: r.client, peer: d.peer as string, epoch: d.epoch_ms as number });
        break;
      case "ctrl-rtt":
        ctrlRtt.push(d.rtt_ms as number);
        break;
      case "rtc":
        if (d.rtt_ms != null) rtcRtt.push(d.rtt_ms as number);
        if (d.jitter_ms != null) rtcJitter.push(d.jitter_ms as number);
        if (d.packets_lost != null) rtcLost.push(d.packets_lost as number);
        break;
      case "media":
        mediaLatest.set(r.client, d); // cumulative counters: keep latest per client
        break;
      case "join":
        if (d.joined_ms != null) joinMs.push(d.joined_ms as number);
        break;
      case "error":
        errors.push({ client: r.client, ...d });
        break;
    }
  }
  for (const xs of sent.values()) xs.sort((a, b) => a - b);

  // correlate: detection at epoch E from peer P pairs with P's latest sent < E (within 1.5s)
  const latencies: number[] = [];
  for (const det of detected) {
    const xs = sent.get(det.peer);
    if (!xs) continue;
    let lo = 0, hi = xs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < det.epoch) lo = mid + 1; else hi = mid; }
    const idx = lo - 1;
    if (idx >= 0) {
      const lat = det.epoch - xs[idx];
      if (lat >= 0 && lat < 1500) latencies.push(lat);
    }
  }

  let sentFrames = 0, recvFrames = 0, recvBytes = 0;
  for (const d of mediaLatest.values()) {
    sentFrames += (d.sent_frames as number) ?? 0;
    recvFrames += (d.recv_frames as number) ?? 0;
    recvBytes += (d.recv_bytes as number) ?? 0;
  }

  const sLast = serverRows[serverRows.length - 1]?.data;
  const sFirst = serverRows[0]?.data;

  return {
    audio_latency_ms: statsOf(latencies),
    ctrl_rtt_ms: statsOf(ctrlRtt),
    rtc: { rtt_ms: statsOf(rtcRtt), jitter_ms: statsOf(rtcJitter), packets_lost_max: rtcLost.length ? Math.max(...rtcLost) : 0 },
    media: { sent_frames_total: sentFrames, recv_frames_total: recvFrames, recv_bytes_total: recvBytes },
    join_ms: statsOf(joinMs),
    server: sLast && sFirst ? {
      rss_bytes_max: Math.max(...serverRows.map((r) => r.data.rss_bytes ?? 0)),
      cpu_s_delta: (sLast.cpu_s ?? 0) - (sFirst.cpu_s ?? 0),
      peers_max: Math.max(...serverRows.map((r) => r.data.peers ?? 0)),
      media_frames_total: sLast.media_frames_total ?? 0,
    } : null,
    errors: { count: errors.length, sample: errors.slice(0, 5) },
  };
}

export function fmtSummary(s: ReturnType<typeof aggregate>): string {
  const f = (x: number | null) => (x == null ? "  -  " : x.toFixed(1));
  return [
    `audio-latency ms  p50=${f(s.audio_latency_ms.p50)} p95=${f(s.audio_latency_ms.p95)} p99=${f(s.audio_latency_ms.p99)} max=${f(s.audio_latency_ms.max)} (n=${s.audio_latency_ms.n})`,
    `ctrl-rtt ms       p50=${f(s.ctrl_rtt_ms.p50)} p99=${f(s.ctrl_rtt_ms.p99)} (n=${s.ctrl_rtt_ms.n})`,
    `rtc rtt ms        p50=${f(s.rtc.rtt_ms.p50)} p99=${f(s.rtc.rtt_ms.p99)} | jitter p50=${f(s.rtc.jitter_ms.p50)} p99=${f(s.rtc.jitter_ms.p99)} lost_max=${s.rtc.packets_lost_max}`,
    `media             sent=${s.media.sent_frames_total} recv=${s.media.recv_frames_total} bytes=${s.media.recv_bytes_total}`,
    `join ms           p50=${f(s.join_ms.p50)} p99=${f(s.join_ms.p99)}`,
    `server            rss_max=${s.server ? (s.server.rss_bytes_max / 1048576).toFixed(1) + "MB" : "-"} cpu_s=${s.server?.cpu_s_delta?.toFixed(2) ?? "-"} peers_max=${s.server?.peers_max ?? "-"} media_frames=${s.server?.media_frames_total ?? "-"}`,
    `errors            ${s.errors.count}${s.errors.count ? " " + JSON.stringify(s.errors.sample) : ""}`,
  ].join("\n");
}
