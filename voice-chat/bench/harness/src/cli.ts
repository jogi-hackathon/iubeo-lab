// CLI: node src/cli.ts <run|check-server|demo> [flags]
//   run          --scenario smoke --transport webrtc-mesh --server ws://localhost:8080
//   check-server --url ws://localhost:8080
//   demo         --transport ws-relay --clients 3 --seconds 20 --out ../demo [--media ...] [--audio --voices a.wav,b.wav]
import { run } from "./run.ts";
import { checkServer } from "./checkServer.ts";
import { demo } from "./demo.ts";

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? "true" : argv[++i];
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const a = args(rest);

if (cmd === "run") {
  await run({
    scenario: a.scenario ?? "smoke",
    transport: a.transport ?? "webrtc-mesh",
    server: a.server ?? "ws://localhost:8080",
    browsers: a.browsers ? Number(a.browsers) : undefined,
    media: a.media,
    mediahash: a.mediahash,
    clientParams: a.params,
  });
} else if (cmd === "check-server") {
  await checkServer(a.url ?? a.server ?? "ws://localhost:8080");
} else if (cmd === "try") {
  const { tryIt } = await import("./try.ts");
  await tryIt({
    server: a.server ?? "ws://localhost:8081",
    media: a.media ?? "https://localhost:4443",
    room: a.room ?? "dev",
    transport: a.transport ?? "moq",
  });
} else if (cmd === "demo") {
  if (a.world === "true" || a.world === "1") {
    const { demoWorld } = await import("./demo.ts");
    await demoWorld({
      server: a.server ?? "ws://localhost:8080",
      transport: a.transport ?? "moq",
      clients: a.clients ? Number(a.clients) : undefined,
      seconds: a.seconds ? Number(a.seconds) : undefined,
      out: a.out,
      media: a.media,
      mediahash: a.mediahash,
      voices: a.voices?.split(","),
      audio: a.audio === "true" || a.audio === "1" || !!a.voices,
      self: a.self !== "0" && a.self !== "false",
    });
    process.exit(0);
  }
  await demo({
    server: a.server ?? "ws://localhost:8080",
    transport: a.transport ?? "ws-relay",
    clients: a.clients ? Number(a.clients) : undefined,
    seconds: a.seconds ? Number(a.seconds) : undefined,
    out: a.out,
    media: a.media,
    mediahash: a.mediahash,
    voices: a.voices?.split(","),
    audio: a.audio === "true" || a.audio === "1" || !!a.voices,
    self: a.self !== "0" && a.self !== "false",
    chaos: a.chaos,
    uchaos: a.uchaos,
  });
} else {
  console.error("usage: cli.ts <run|check-server|demo|try> [--scenario|--transport|--server|--url ...]");
  process.exit(2);
}
