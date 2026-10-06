// zig_vc — contract-compliant VC server in Zig 0.16 (no deps, raw libc sockets).
// std.net/std.posix sockets are gone in 0.16 (moved to the new std.Io async
// model), so this uses std.c syscalls directly + std.Thread per connection.
// Implements docs/protocol.md: /v1/signaling, /healthz, /metrics.
const std = @import("std");
const c = std.c;
const Sha1 = std.crypto.hash.Sha1;
const Ed25519 = std.crypto.sign.Ed25519;
const base64url = std.base64.url_safe_no_pad;
const base64std = std.base64.standard;

const PORT: u16 = 8084;
const MAX_FRAME: usize = 1 << 20;
const ROOM_MAX: usize = 8;
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const alloc = std.heap.smp_allocator;

// std.Thread.Mutex is gone in 0.16 — pthread directly
const Mutex = struct {
    m: c.pthread_mutex_t = c.PTHREAD_MUTEX_INITIALIZER,
    fn lock(self: *Mutex) void {
        _ = c.pthread_mutex_lock(&self.m);
    }
    fn unlock(self: *Mutex) void {
        _ = c.pthread_mutex_unlock(&self.m);
    }
};

var pub_key: Ed25519.PublicKey = undefined;

var started_at: i64 = 0;
var signal_msgs: std.atomic.Value(u64) = .init(0);
var media_frames: std.atomic.Value(u64) = .init(0);
var media_bytes: std.atomic.Value(u64) = .init(0);

fn epochSecs() i64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.REALTIME, &ts);
    return @intCast(ts.sec);
}

// std.c has no getrusage binding in 0.16; declare it.
const RUsage = extern struct {
    ru_utime: c.timeval,
    ru_stime: c.timeval,
    ru_maxrss: c_long,
    ru_ixrss: c_long,
    ru_idrss: c_long,
    ru_isrss: c_long,
    ru_minflt: c_long,
    ru_majflt: c_long,
    ru_nswap: c_long,
    ru_inblock: c_long,
    ru_oublock: c_long,
    ru_msgsnd: c_long,
    ru_msgrcv: c_long,
    ru_nsignals: c_long,
    ru_nvcsw: c_long,
    ru_nivcsw: c_long,
};
extern "c" fn getrusage(who: c_int, usage: *RUsage) c_int;

fn usageRss() u64 {
    var ru: RUsage = undefined;
    if (getrusage(0, &ru) != 0) return 0;
    // ru_maxrss is bytes on macOS, KiB on Linux
    const v: u64 = @intCast(@max(ru.ru_maxrss, 0));
    return if (@import("builtin").os.tag == .macos) v else v * 1024;
}

fn usageCpu() f64 {
    var ru: RUsage = undefined;
    if (getrusage(0, &ru) != 0) return 0;
    const us: f64 = @floatFromInt(ru.ru_utime.sec * 1_000_000 + ru.ru_utime.usec + ru.ru_stime.sec * 1_000_000 + ru.ru_stime.usec);
    return us / 1_000_000.0;
}

// ---------- fd io ----------

const Fd = c.fd_t;

fn fdRead(fd: Fd, buf: []u8) !usize {
    const n = c.read(fd, buf.ptr, buf.len);
    if (n <= 0) return error.Closed;
    return @intCast(n);
}

fn fdReadAll(fd: Fd, buf: []u8) !void {
    var off: usize = 0;
    while (off < buf.len) off += try fdRead(fd, buf[off..]);
}

fn fdWriteAll(fd: Fd, buf: []const u8) !void {
    var off: usize = 0;
    while (off < buf.len) {
        const n = c.write(fd, buf.ptr + off, buf.len - off);
        if (n <= 0) return error.Closed;
        off += @intCast(n);
    }
}

// ---------- rooms ----------

const Peer = struct {
    id: []const u8,
    fd: Fd,
    wmu: Mutex = .{},
};

const Room = struct {
    peers: std.StringHashMap(*Peer),

    fn sendAll(self: *Room, except: []const u8, text: []const u8) void {
        var it = self.peers.iterator();
        while (it.next()) |e| {
            if (!std.mem.eql(u8, e.key_ptr.*, except)) sendText(e.value_ptr.*, text);
        }
    }
    fn relayBin(self: *Room, except: []const u8, data: []const u8) void {
        var it = self.peers.iterator();
        while (it.next()) |e| {
            if (!std.mem.eql(u8, e.key_ptr.*, except)) sendBin(e.value_ptr.*, data);
        }
    }
};

var rooms_mu: Mutex = .{};
var rooms: std.StringHashMap(*Room) = undefined;

fn sendFrame(p: *Peer, opcode: u8, payload: []const u8) void {
    var hdr: [10]u8 = undefined;
    hdr[0] = 0x80 | opcode;
    var n: usize = 2;
    if (payload.len < 126) {
        hdr[1] = @intCast(payload.len);
    } else if (payload.len <= 0xffff) {
        hdr[1] = 126;
        std.mem.writeInt(u16, hdr[2..4], @intCast(payload.len), .big);
        n = 4;
    } else {
        hdr[1] = 127;
        std.mem.writeInt(u64, hdr[2..10], @intCast(payload.len), .big);
        n = 10;
    }
    p.wmu.lock();
    defer p.wmu.unlock();
    fdWriteAll(p.fd, hdr[0..n]) catch return;
    fdWriteAll(p.fd, payload) catch return;
}

fn sendText(p: *Peer, s: []const u8) void {
    sendFrame(p, 0x1, s);
}
fn sendBin(p: *Peer, b: []const u8) void {
    sendFrame(p, 0x2, b);
}

// ---------- JWT ----------

fn b64urlDecode(dst: []u8, s: []const u8) ![]const u8 {
    const n = try base64url.Decoder.calcSizeForSlice(s);
    try base64url.Decoder.decode(dst[0..n], s);
    return dst[0..n];
}

const Claims = struct { sub: []const u8 = "", room: []const u8 = "", exp: i64 = 0 };

fn verifyJWT(tok: []const u8) ?Claims {
    const dot1 = std.mem.indexOfScalar(u8, tok, '.') orelse return null;
    const rest = tok[dot1 + 1 ..];
    const dot2r = std.mem.indexOfScalar(u8, rest, '.') orelse return null;
    const signing = tok[0 .. dot1 + 1 + dot2r];
    const sig_b64 = tok[dot1 + 1 + dot2r + 1 ..];

    var hdr_buf: [512]u8 = undefined;
    const hdr = b64urlDecode(&hdr_buf, tok[0..dot1]) catch return null;
    if (std.mem.indexOf(u8, hdr, "\"EdDSA\"") == null) return null;

    var sig_buf: [128]u8 = undefined;
    const sig_raw = b64urlDecode(&sig_buf, sig_b64) catch return null;
    if (sig_raw.len != 64) return null;
    const sig = Ed25519.Signature.fromBytes(sig_raw[0..64].*);
    sig.verify(signing, pub_key) catch return null;

    var pay_buf: [2048]u8 = undefined;
    const pay = b64urlDecode(&pay_buf, rest[0..dot2r]) catch return null;
    const parsed = std.json.parseFromSlice(Claims, alloc, pay, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    const cl = parsed.value;
    if (cl.sub.len == 0 or cl.room.len == 0 or cl.exp <= epochSecs()) return null;
    return .{
        .sub = alloc.dupe(u8, cl.sub) catch return null,
        .room = alloc.dupe(u8, cl.room) catch return null,
        .exp = cl.exp,
    };
}

// ---------- HTTP / WS ----------

fn readHeaders(fd: Fd, buf: []u8) !usize {
    var n: usize = 0;
    while (n < buf.len) {
        n += try fdRead(fd, buf[n..]);
        if (std.mem.endsWith(u8, buf[0..n], "\r\n\r\n")) return n;
    }
    return error.TooLong;
}

fn headerVal(req: []const u8, name: []const u8) ?[]const u8 {
    var it = std.mem.splitSequence(u8, req, "\r\n");
    _ = it.next();
    while (it.next()) |line| {
        if (std.mem.indexOfScalar(u8, line, ':')) |col| {
            if (std.ascii.eqlIgnoreCase(std.mem.trim(u8, line[0..col], " "), name))
                return std.mem.trim(u8, line[col + 1 ..], " ");
        }
    }
    return null;
}

fn wsAcceptKey(key: []const u8) [28]u8 {
    var sha: Sha1 = .init(.{});
    sha.update(key);
    sha.update(WS_MAGIC);
    var digest: [20]u8 = undefined;
    sha.final(&digest);
    var out: [28]u8 = undefined;
    _ = base64std.Encoder.encode(&out, &digest);
    return out;
}

fn readFrame(fd: Fd, buf: []u8) ?struct { op: u8, data: []const u8 } {
    var h: [2]u8 = undefined;
    fdReadAll(fd, &h) catch return null;
    const op = h[0] & 0x0f;
    const masked = h[1] & 0x80 != 0;
    var len: u64 = h[1] & 0x7f;
    if (len == 126) {
        var e: [2]u8 = undefined;
        fdReadAll(fd, &e) catch return null;
        len = std.mem.readInt(u16, &e, .big);
    } else if (len == 127) {
        var e: [8]u8 = undefined;
        fdReadAll(fd, &e) catch return null;
        len = std.mem.readInt(u64, &e, .big);
    }
    if (len > MAX_FRAME) return null;
    var mask: [4]u8 = .{0} ** 4;
    if (masked) fdReadAll(fd, &mask) catch return null;
    fdReadAll(fd, buf[0..@intCast(len)]) catch return null;
    const data = buf[0..@intCast(len)];
    if (masked) {
        for (data, 0..) |*b, i| b.* ^= mask[i % 4];
    }
    return .{ .op = op, .data = data };
}

fn respond(fd: Fd, status: []const u8, body: []const u8) void {
    var b: [1024]u8 = undefined;
    const r = std.fmt.bufPrint(&b, "HTTP/1.1 {s}\r\ncontent-type: application/json\r\ncontent-length: {d}\r\nconnection: close\r\n\r\n{s}", .{ status, body.len, body }) catch return;
    fdWriteAll(fd, r) catch {};
}

fn handleConn(fd: Fd) void {
    defer _ = c.close(fd);
    var req_buf: [8192]u8 = undefined;
    const n = readHeaders(fd, &req_buf) catch return;
    const req = req_buf[0..n];

    const sp1 = std.mem.indexOfScalar(u8, req, ' ') orelse return;
    const path_q = req[sp1 + 1 .. std.mem.indexOfScalarPos(u8, req, sp1 + 1, ' ') orelse return];

    if (std.mem.eql(u8, path_q, "/healthz")) {
        respond(fd, "200 OK", "{\"ok\":true}");
        return;
    }
    if (std.mem.eql(u8, path_q, "/metrics")) {
        respondMetrics(fd);
        return;
    }
    if (!std.mem.startsWith(u8, path_q, "/v1/signaling")) {
        respond(fd, "404 Not Found", "{\"error\":\"not found\"}");
        return;
    }

    const q = std.mem.indexOfScalar(u8, path_q, '?') orelse {
        respond(fd, "401 Unauthorized", "{\"error\":\"no token\"}");
        return;
    };
    const qs = path_q[q + 1 ..];
    var tok: []const u8 = "";
    var it = std.mem.splitScalar(u8, qs, '&');
    while (it.next()) |kv| {
        if (std.mem.startsWith(u8, kv, "token=")) tok = kv[6..];
    }
    const claims = verifyJWT(tok) orelse {
        respond(fd, "401 Unauthorized", "{\"error\":\"bad token\"}");
        return;
    };

    const key = headerVal(req, "sec-websocket-key") orelse {
        respond(fd, "400 Bad Request", "{\"error\":\"no ws key\"}");
        return;
    };
    var resp: [256]u8 = undefined;
    const r101 = std.fmt.bufPrint(&resp, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {s}\r\n\r\n", .{wsAcceptKey(key)}) catch return;
    fdWriteAll(fd, r101) catch return;

    var peer = Peer{ .id = claims.sub, .fd = fd };
    const room_id = claims.room;

    // join
    rooms_mu.lock();
    const gop = rooms.getOrPut(room_id) catch {
        rooms_mu.unlock();
        return;
    };
    if (!gop.found_existing) {
        const rm = alloc.create(Room) catch {
            rooms_mu.unlock();
            return;
        };
        rm.* = .{ .peers = std.StringHashMap(*Peer).init(alloc) };
        gop.value_ptr.* = rm;
    }
    const rm = gop.value_ptr.*;
    if (rm.peers.contains(claims.sub) or rm.peers.count() >= ROOM_MAX) {
        rooms_mu.unlock();
        sendFrame(&peer, 0x8, "room full or duplicate id");
        return;
    }
    var roster: std.ArrayList(u8) = .empty;
    roster.appendSlice(alloc, "{\"type\":\"peers\",\"peers\":[") catch {};
    var pit = rm.peers.iterator();
    var first = true;
    while (pit.next()) |e| {
        if (!first) roster.appendSlice(alloc, ",") catch {};
        first = false;
        roster.print(alloc, "{{\"id\":\"{s}\"}}", .{e.key_ptr.*}) catch {};
    }
    roster.appendSlice(alloc, "]}") catch {};
    rm.peers.put(claims.sub, &peer) catch {};
    var joined_buf: [128]u8 = undefined;
    const joined = std.fmt.bufPrint(&joined_buf, "{{\"type\":\"peer-joined\",\"id\":\"{s}\"}}", .{claims.sub}) catch "";
    rm.sendAll(claims.sub, joined);
    rooms_mu.unlock();

    sendText(&peer, roster.items);

    defer {
        rooms_mu.lock();
        _ = rm.peers.remove(claims.sub);
        var left_buf: [128]u8 = undefined;
        const left = std.fmt.bufPrint(&left_buf, "{{\"type\":\"peer-left\",\"id\":\"{s}\"}}", .{claims.sub}) catch "";
        rm.sendAll(claims.sub, left);
        if (rm.peers.count() == 0) {
            _ = rooms.remove(room_id);
            rm.peers.deinit();
            alloc.destroy(rm);
        }
        rooms_mu.unlock();
    }

    const fbuf = alloc.alloc(u8, MAX_FRAME) catch return;
    defer alloc.free(fbuf);
    while (readFrame(fd, fbuf)) |f| {
        switch (f.op) {
            0x8 => return,
            0x9 => sendFrame(&peer, 0xA, f.data),
            0x2 => {
                _ = media_frames.fetchAdd(1, .monotonic);
                _ = media_bytes.fetchAdd(f.data.len, .monotonic);
                rooms_mu.lock();
                rm.relayBin(claims.sub, f.data);
                rooms_mu.unlock();
            },
            0x1 => handleText(&peer, rm, claims.sub, f.data),
            else => {},
        }
    }
}

fn handleText(peer: *Peer, rm: *Room, self_id: []const u8, data: []const u8) void {
    const M = struct { type: []const u8 = "", to: []const u8 = "", t: f64 = 0, data: std.json.Value = .null };
    const parsed = std.json.parseFromSlice(M, alloc, data, .{ .ignore_unknown_fields = true }) catch return;
    defer parsed.deinit();
    const m = parsed.value;
    if (std.mem.eql(u8, m.type, "ping")) {
        var b: [96]u8 = undefined;
        const s = std.fmt.bufPrint(&b, "{{\"type\":\"pong\",\"t\":{d}}}", .{m.t}) catch return;
        sendText(peer, s);
    } else if (std.mem.eql(u8, m.type, "signal")) {
        _ = signal_msgs.fetchAdd(1, .monotonic);
        var out: std.ArrayList(u8) = .empty;
        defer out.deinit(alloc);
        out.print(alloc, "{{\"type\":\"signal\",\"from\":\"{s}\",\"data\":{f}}}", .{ self_id, std.json.fmt(m.data, .{}) }) catch return;
        rooms_mu.lock();
        defer rooms_mu.unlock();
        if (rm.peers.get(m.to)) |target| {
            sendText(target, out.items);
        } else {
            var b: [256]u8 = undefined;
            const s = std.fmt.bufPrint(&b, "{{\"type\":\"error\",\"code\":\"no_such_peer\",\"message\":\"{s}\"}}", .{m.to}) catch return;
            sendText(peer, s);
        }
    }
}

fn respondMetrics(fd: Fd) void {
    rooms_mu.lock();
    var room_count: usize = 0;
    var peer_count: usize = 0;
    var it = rooms.iterator();
    while (it.next()) |e| {
        room_count += 1;
        peer_count += e.value_ptr.*.peers.count();
    }
    rooms_mu.unlock();
    var b: [1024]u8 = undefined;
    const body = std.fmt.bufPrint(&b, "{{\"uptime_s\":{d},\"ws_connections\":{d},\"rooms\":{d},\"peers\":{d},\"signal_msgs_total\":{d},\"media_frames_total\":{d},\"media_bytes_total\":{d},\"rss_bytes\":{d},\"cpu_s\":{d}}}", .{
        epochSecs() - started_at,
        peer_count,
        room_count,
        peer_count,
        signal_msgs.load(.monotonic),
        media_frames.load(.monotonic),
        media_bytes.load(.monotonic),
        usageRss(),
        usageCpu(),
    }) catch return;
    respond(fd, "200 OK", body);
}

fn readFileC(path: []const u8) ?[]u8 {
    const pz = alloc.dupeZ(u8, path) catch return null;
    defer alloc.free(pz);
    const fd = c.open(pz.ptr, .{}, @as(c.mode_t, 0));
    if (fd < 0) return null;
    defer _ = c.close(fd);
    const data = alloc.alloc(u8, 1 << 16) catch return null;
    var total: usize = 0;
    while (total < data.len) {
        const n = c.read(fd, data.ptr + total, data.len - total);
        if (n <= 0) break;
        total += @intCast(n);
    }
    return data[0..total];
}

fn loadPubKey() void {
    const env = c.getenv("VC_PUBLIC_KEY_PATH");
    var path: []const u8 = if (env) |e| std.mem.span(e) else "";
    var data: ?[]u8 = null;
    if (path.len != 0) {
        data = readFileC(path);
    } else {
        const candidates = [_][]const u8{
            "../../bench/dev-keys/public.jwk",
            "bench/dev-keys/public.jwk",
        };
        for (candidates) |cand| {
            if (readFileC(cand)) |d| {
                data = d;
                path = cand;
                break;
            }
        }
    }
    const raw_json = data orelse {
        std.debug.print("public.jwk not found (set VC_PUBLIC_KEY_PATH)\n", .{});
        std.process.exit(1);
    };
    const K = struct { x: []const u8 };
    const parsed = std.json.parseFromSlice(K, alloc, raw_json, .{ .ignore_unknown_fields = true }) catch {
        std.debug.print("bad jwk\n", .{});
        std.process.exit(1);
    };
    var raw: [64]u8 = undefined;
    const dec = b64urlDecode(&raw, parsed.value.x) catch {
        std.debug.print("bad jwk x\n", .{});
        std.process.exit(1);
    };
    pub_key = Ed25519.PublicKey.fromBytes(dec[0..32].*) catch {
        std.debug.print("bad pubkey\n", .{});
        std.process.exit(1);
    };
}

pub fn main() !void {
    started_at = epochSecs();
    rooms = std.StringHashMap(*Room).init(alloc);
    loadPubKey();

    const lfd = c.socket(c.AF.INET, c.SOCK.STREAM, 0);
    if (lfd < 0) return error.Socket;
    var one: c_int = 1;
    _ = c.setsockopt(lfd, c.SOL.SOCKET, c.SO.REUSEADDR, &one, @sizeOf(c_int));
    const sa = c.sockaddr.in{
        .port = std.mem.nativeToBig(u16, PORT),
        .addr = 0, // INADDR_ANY
    };
    if (c.bind(lfd, @ptrCast(&sa), @sizeOf(c.sockaddr.in)) != 0) return error.Bind;
    if (c.listen(lfd, 128) != 0) return error.Listen;
    std.debug.print("[zig_vc] ws://localhost:{d}/v1/signaling\n", .{PORT});
    while (true) {
        const fd = c.accept(lfd, null, null);
        if (fd < 0) continue;
        const t = std.Thread.spawn(.{}, handleConn, .{fd}) catch {
            _ = c.close(fd);
            continue;
        };
        t.detach();
    }
}
