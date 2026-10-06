import { parseServerMsg, type ServerMsg, type ClientMsg } from "@vc/protocol";

export class Signaling {
  ws: WebSocket;
  onMsg: (m: ServerMsg) => void = () => {};
  onBinary: (b: ArrayBuffer) => void = () => {};
  ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error("ws error"));
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const m = parseServerMsg(ev.data);
        if (m) this.onMsg(m);
      } else {
        this.onBinary(ev.data as ArrayBuffer);
      }
    };
  }

  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }

  sendBinary(b: ArrayBuffer) {
    this.ws.send(b);
  }
}
