import type { ServerMsg } from "@vc/protocol";
import type { Transport, TransportCtx } from "./types";
import { attachStreamDetector } from "../audio/detector";

type Sig = { to: string; data: unknown };

// WebRTC full mesh: newcomer offers to the initial roster; existing peers answer.
export class WebRTCMesh implements Transport {
  name = "webrtc-mesh";
  private c!: TransportCtx;
  private pcs = new Map<string, RTCPeerConnection>();
  private dets = new Map<string, import("../audio/detector").Detector>();
  private frames = { recv: 0, bytes: 0 };

  async start(c: TransportCtx): Promise<void> {
    this.c = c;
    this.gainTimer = setInterval(() => {
      for (const [peer, det] of this.dets) det.gain = c.gains?.get(peer) ?? 1;
    }, 250);
    for (const peerId of c.peers) await this.offer(peerId);
  }

  private gainTimer?: ReturnType<typeof setInterval>;

  private mkPeer(peerId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTrack(this.c.audio.track);
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(peerId, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      const det = attachStreamDetector(this.c.ctx, stream, (ctxTime) =>
        this.c.onDetected(peerId, this.c.clock.toEpoch(ctxTime)),
      this.c.record, this.c.play);
      det.onpcm = (f) => this.c.onRecvPcm?.(peerId, f);
      this.dets.set(peerId, det);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed")
        this.c.report("error", { message: "ice failed", peer: peerId });
    };
    this.pcs.set(peerId, pc);
    return pc;
  }

  private send(to: string, data: unknown) {
    this.c.sig.send({ type: "signal", to, data });
  }

  private async offer(peerId: string) {
    const pc = this.mkPeer(peerId);
    const sdp = await pc.createOffer();
    await pc.setLocalDescription(sdp);
    this.send(peerId, { sdp: pc.localDescription!.toJSON() });
  }

  async handleMsg(m: ServerMsg): Promise<void> {
    if (m.type === "peer-joined") return; // newcomer offers; we just answer
    if (m.type === "peer-left") {
      this.pcs.get(m.id)?.close();
      this.pcs.delete(m.id);
      return;
    }
    if (m.type !== "signal") return;
    const from = m.from;
    const d = m.data as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
    let pc = this.pcs.get(from);
    if (d.sdp?.type === "offer") {
      pc = pc ?? this.mkPeer(from);
      await pc.setRemoteDescription(d.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      this.send(from, { sdp: pc.localDescription!.toJSON() });
    } else if (d.sdp?.type === "answer" && pc) {
      await pc.setRemoteDescription(d.sdp);
    } else if (d.candidate && pc) {
      await pc.addIceCandidate(d.candidate).catch(() => {});
    }
  }

  async stats(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const [peer, pc] of this.pcs) {
      let rtt: number | undefined, jitter: number | undefined, lost: number | undefined,
        bytes: number | undefined, level: number | undefined;
      const s = await pc.getStats();
      s.forEach((r) => {
        if (r.type === "candidate-pair" && (r as any).state === "succeeded" && (r as any).nominated)
          rtt = ((r as any).currentRoundTripTime ?? 0) * 1000;
        if (r.type === "inbound-rtp" && (r as any).kind === "audio") {
          jitter = ((r as any).jitter ?? 0) * 1000;
          lost = (r as any).packetsLost;
          bytes = (r as any).bytesReceived;
        }
        if (r.type === "media-playout") level = undefined; // noop
      });
      // audio level: RMS from the detector worklet (all builds)
      level = this.dets.get(peer)?.level;
      out.push({ peer, rtt_ms: rtt, jitter_ms: jitter, packets_lost: lost, bytes_recv: bytes, audio_level: level });
    }
    return out;
  }

  close() {
    for (const pc of this.pcs.values()) pc.close();
    this.pcs.clear();
  }
}
