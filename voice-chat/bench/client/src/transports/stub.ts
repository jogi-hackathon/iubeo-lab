import type { Transport, TransportCtx } from "./types";

// Slots for future transports. Same Transport contract, same metrics pipeline.

export class WebTransportDatagram implements Transport {
  name = "wt-datagram";
  needsPcm = true;
  async start(c: TransportCtx): Promise<void> {
    // TODO: WebTransport to media relay; datagrams carry same media frame format.
    // Note: localhost WT needs TLS — use serverCertificateHashes with a dev cert.
    c.report("error", { message: "wt-datagram not implemented" });
  }
  async stats() { return [{}]; }
  close() {}
}

export class MoqTransport implements Transport {
  name = "moq";
  needsPcm = true;
  async start(c: TransportCtx): Promise<void> {
    // TODO: MOQT over WebTransport (moq-js or moqt-js), Opus in LOC.
    // Relay candidates: moq-rs self-host / own relay on moqt-rs / Sora Labo trial.
    c.report("error", { message: "moq not implemented" });
  }
  async stats() { return [{}]; }
  close() {}
}
