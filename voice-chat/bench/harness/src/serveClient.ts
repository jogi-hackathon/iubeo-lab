import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Defaults baked into the served pages as window.__VC_CFG — the lobby page
// needs the vc service address to list/join rooms, and the world page falls
// back to these when its URL carries no explicit params (walk-in flow).
export interface VcCfg {
  server?: string; media?: string; wthash?: string; transport?: string;
}

// Bundle bench/client and serve it in-memory. Returns base URL.
//   /      → lobby: live room list + create-or-join
//   /world → the 3d world client
//   /bench → the benchmark client page (explicit params required)
export async function serveClient(cfg: VcCfg = {}): Promise<{ url: string; close(): void }> {
  const dir = fileURLToPath(new URL("../../client/src/", import.meta.url));
  const out = await build({
    entryPoints: { client: `${dir}main.ts`, world: `${dir}world.ts` },
    bundle: true,
    format: "iife",
    write: false,
    outdir: "out",
    logLevel: "silent",
  });
  const files = Object.fromEntries(out.outputFiles.map((f) => [f.path.split("/").pop()!, f.text]));
  const cfgScript = `<script>window.__VC_CFG=${JSON.stringify(cfg)}</script>`;
  const html = `<!doctype html><meta charset="utf-8"><title>vc-bench</title><body><script src="/client.js"></script>`;
  const worldHtml = `<!doctype html><meta charset="utf-8"><title>vc world</title>
<style>body{margin:0;background:#0b0e14;overflow:hidden}#hud{position:fixed;left:10px;top:10px;color:#e6edf3;font:13px/1.5 ui-monospace,monospace;text-shadow:0 1px 2px #000;white-space:pre;pointer-events:none}#keys{position:fixed;left:10px;bottom:10px;color:#8b949e;font:11px ui-monospace,monospace;text-shadow:0 1px 2px #000;pointer-events:none}
#mutebar{position:fixed;right:10px;bottom:10px;display:none;gap:8px}#mutebar button{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#3fb950;font:12px ui-monospace,monospace;padding:6px 12px;cursor:pointer}#mutebar button:hover{border-color:#58a6ff}
#gate{display:none;position:fixed;inset:0;background:rgba(11,14,20,0.82);z-index:10;align-items:center;justify-content:center;cursor:pointer}#gate .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:28px 44px;text-align:center;color:#e6edf3;font:15px/1.7 ui-monospace,monospace}#gate .join{color:#3fb950;font-size:20px;font-weight:700}
#dbg{position:fixed;right:10px;top:10px;background:rgba(11,14,20,0.87);border:1px solid #30363d;border-radius:8px;color:#e6edf3;font:11px/1.45 ui-monospace,monospace;padding:10px 12px;white-space:pre;display:none;pointer-events:none;min-width:230px}</style>
<div id="hud">connecting…</div><div id="dbg"></div><div id="keys">WASD/arrows move · QE rotate · M mic · N hear · \` dbg · drag to orbit</div>
<div id="mutebar"><button id="bmic">mic</button><button id="bspk">hear</button></div>
<div id="gate"><div class="card"><div class="join">click to join voice</div><div id="gatehint">mic + speakers go live on click</div></div></div>
<body>${cfgScript}<script src="/world.js"></script>`;

  // lobby: room list + create-or-join. Plain DOM (no innerHTML with
  // server data — names are user-controlled).
  const lobbyHtml = `<!doctype html><meta charset="utf-8"><title>vc world — lobby</title>
<style>
body{margin:0;background:#0b0e14;color:#e6edf3;font:14px/1.6 ui-monospace,monospace;display:flex;justify-content:center;padding-top:8vh}
#app{width:min(560px,90vw)}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:24px}
label{display:block;color:#8b949e;font-size:12px;margin-bottom:6px}
input{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font:14px ui-monospace,monospace;padding:8px 12px;width:100%;box-sizing:border-box}
input:focus{outline:none;border-color:#58a6ff}
button{background:#161b22;border:1px solid #30363d;border-radius:6px;color:#3fb950;font:13px ui-monospace,monospace;padding:6px 16px;cursor:pointer;white-space:nowrap}
button:hover{border-color:#58a6ff}
#rooms{list-style:none;padding:0;margin:0}
#rooms li{display:flex;align-items:center;gap:10px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:10px 14px;margin-bottom:8px}
#rooms li .nm{font-weight:600}
#rooms li .cnt{color:#58a6ff;font-size:12px}
#rooms li .ids{color:#8b949e;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis}
#rooms li.empty{color:#8b949e;background:none;border-style:dashed;justify-content:center}
.row{display:flex;gap:10px;margin-top:10px}
.row input{flex:1}
#err{color:#f85149;font-size:12px;min-height:1.2em;margin-top:12px}
h2{font-size:13px;color:#8b949e;font-weight:600;margin:24px 0 8px;display:flex;align-items:center;gap:10px}
h2 button{padding:2px 10px;font-size:11px}
</style>
<div id="app">
<h1>vc world</h1>
<div class="sub">walk in — pick a room or make one</div>
<label>your name (optional)</label>
<input id="nm" placeholder="random p-xxxx" maxlength="24">
<h2>rooms <button id="rf">↻</button></h2>
<ul id="rooms"></ul>
<div class="row"><input id="rn" placeholder="new room name" maxlength="32"><button id="mk">create</button></div>
<div id="err"></div>
</div>
<body>${cfgScript}<script>
const cfg = window.__VC_CFG ?? {};
const api = (cfg.server ?? "").replace(/^ws/, "http");
const $ = (id) => document.getElementById(id);
const nm = $("nm"), rn = $("rn"), mk = $("mk"), ul = $("rooms"), err = $("err");
nm.value = localStorage.getItem("vc-name") ?? "";
nm.oninput = () => localStorage.setItem("vc-name", nm.value);

const go = (room) => {
  const q = "room=" + encodeURIComponent(room) +
    (nm.value.trim() ? "&name=" + encodeURIComponent(nm.value.trim()) : "");
  location.href = "/world?" + q;
};

let lastRooms = [];
const flipLabel = () => {
  mk.textContent = lastRooms.some((r) => r.name === rn.value.trim()) ? "join" : "create";
};
const render = (rooms) => {
  lastRooms = rooms;
  ul.innerHTML = "";
  rooms.sort((a, b) => b.members - a.members);
  if (!rooms.length) {
    const li = document.createElement("li");
    li.className = "empty"; li.textContent = "(no rooms yet — make one below)";
    ul.appendChild(li);
  }
  for (const r of rooms) {
    const li = document.createElement("li");
    const a = document.createElement("span"); a.className = "nm"; a.textContent = r.name;
    const c = document.createElement("span"); c.className = "cnt"; c.textContent = r.members + "/8";
    const d = document.createElement("span"); d.className = "ids"; d.textContent = r.ids.join(", ");
    const b = document.createElement("button"); b.textContent = "join";
    b.onclick = () => go(r.name);
    li.append(a, c, d, b); ul.appendChild(li);
  }
  flipLabel();
};

const refresh = async () => {
  err.textContent = "";
  try { render((await (await fetch(api + "/v1/rooms")).json()).rooms); }
  catch { err.textContent = "can't reach vc server at " + api; }
};
$("rf").onclick = refresh;
mk.onclick = () => {
  const r = rn.value.trim();
  if (!r) return;
  if (/[\\s\\/\\\\]/.test(r)) { err.textContent = "room name: no spaces or slashes"; return; }
  go(r);
};
rn.oninput = flipLabel; // create↔join label flips live as you type an existing name
rn.onkeydown = (e) => { if (e.key === "Enter") mk.click(); };
nm.onkeydown = (e) => { if (e.key === "Enter") rn.focus(); };
if (!api) err.textContent = "no vc server configured (__VC_CFG.server missing)";
setInterval(refresh, 3000); refresh();
</script>`;

  const server: Server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path === "/client.js") {
      res.writeHead(200, { "content-type": "application/javascript" }).end(files["client.js"]);
    } else if (path === "/world.js") {
      res.writeHead(200, { "content-type": "application/javascript" }).end(files["world.js"]);
    } else if (path === "/world") {
      res.writeHead(200, { "content-type": "text/html" }).end(worldHtml);
    } else if (path === "/bench") {
      res.writeHead(200, { "content-type": "text/html" }).end(html);
    } else {
      // / and anything else → the lobby
      res.writeHead(200, { "content-type": "text/html" }).end(lobbyHtml);
    }
  });
  // Deployment: a fixed bind address/port (HOST=127.0.0.1 behind a reverse
  // proxy, or 0.0.0.0 to expose directly). Defaults keep the local `bench try`
  // behaviour of an ephemeral loopback port.
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 0);
  await new Promise<void>((r) => server.listen(port, host, r));
  const bound = (server.address() as { port: number }).port;
  // a wildcard bind is not a dialable URL — report loopback instead
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return { url: `http://${shown}:${bound}`, close: () => server.close() };
}
