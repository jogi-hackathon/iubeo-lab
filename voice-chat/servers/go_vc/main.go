// VC server in Go — implements docs/protocol.md contract.
// WS signaling + opaque binary media relay + /healthz /metrics.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var (
	startedAt   = time.Now()
	signalMsgs  atomic.Int64
	mediaFrames atomic.Int64
	mediaBytes  atomic.Int64
	roomMax     = 8
	port        = getEnv("PORT", "8082")
	jwtPubKey   ed25519.PublicKey
)

type peer struct {
	id   string
	conn *websocket.Conn
	mu   sync.Mutex // serialize writes
}

func (p *peer) sendJSON(v any) {
	b, _ := json.Marshal(v)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.conn.Write(ctx, websocket.MessageText, b)
}

func (p *peer) sendBinary(b []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.conn.Write(ctx, websocket.MessageBinary, b)
}

type room struct {
	mu    sync.RWMutex
	peers map[string]*peer
}

var rooms sync.Map // roomID -> *room

// ---------- JWT (EdDSA) verify — stdlib only ----------

func loadPubKey() {
	path := os.Getenv("VC_PUBLIC_KEY_PATH")
	if path == "" {
		// try repo-root and package-dir relative locations
		exe, _ := os.Executable()
		for _, c := range []string{
			"../../bench/dev-keys/public.jwk",
			"bench/dev-keys/public.jwk",
			filepath.Join(filepath.Dir(exe), "..", "..", "bench", "dev-keys", "public.jwk"),
		} {
			if _, err := os.Stat(c); err == nil {
				path = c
				break
			}
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatalf("public.jwk: %v", err)
	}
	var k struct {
		X string `json:"x"`
	}
	if err := json.Unmarshal(data, &k); err != nil {
		log.Fatalf("jwk parse: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(k.X)
	if err != nil || len(raw) != 32 {
		log.Fatalf("bad ed25519 jwk")
	}
	jwtPubKey = raw
}

type claims struct {
	Sub  string `json:"sub"`
	Room string `json:"room"`
	Exp  int64  `json:"exp"`
}

func verifyJWT(tok string) (*claims, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("bad token")
	}
	hdr, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var h struct {
		Alg string `json:"alg"`
	}
	if err := json.Unmarshal(hdr, &h); err != nil || h.Alg != "EdDSA" {
		return nil, fmt.Errorf("bad alg")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, err
	}
	if !ed25519.Verify(jwtPubKey, []byte(parts[0]+"."+parts[1]), sig) {
		return nil, fmt.Errorf("bad sig")
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var c claims
	if err := json.Unmarshal(pb, &c); err != nil {
		return nil, err
	}
	if c.Sub == "" || c.Room == "" || c.Exp <= time.Now().Unix() {
		return nil, fmt.Errorf("bad claims")
	}
	return &c, nil
}

// ---------- rooms ----------

func joinRoom(roomID, id string, conn *websocket.Conn) (*room, []string, bool) {
	ri, _ := rooms.LoadOrStore(roomID, &room{peers: map[string]*peer{}})
	r := ri.(*room)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.peers[id]; dup || len(r.peers) >= roomMax {
		return nil, nil, false
	}
	existing := make([]string, 0, len(r.peers))
	for pid := range r.peers {
		existing = append(existing, pid)
	}
	p := &peer{id: id, conn: conn}
	r.peers[id] = p
	for _, other := range r.peers {
		if other.id != id {
			other.sendJSON(map[string]any{"type": "peer-joined", "id": id})
		}
	}
	return r, existing, true
}

func (r *room) leave(roomID, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, id)
	for _, p := range r.peers {
		p.sendJSON(map[string]any{"type": "peer-left", "id": id})
	}
	if len(r.peers) == 0 {
		rooms.Delete(roomID)
	}
}

// ---------- handlers ----------

func handleWS(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // bench pages are cross-origin localhost
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	roomID, id := c.Room, c.Sub
	rm, existing, ok := joinRoom(roomID, id, conn)
	if !ok {
		conn.Close(4413, "room full or duplicate id")
		return
	}
	p := rm.peers[id]
	p.sendJSON(map[string]any{"type": "peers", "peers": mapPeers(existing)})
	defer rm.leave(roomID, id)

	for {
		mt, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		if mt == websocket.MessageBinary {
			mediaFrames.Add(1)
			mediaBytes.Add(int64(len(data)))
			rm.mu.RLock()
			for _, other := range rm.peers {
				if other.id != id {
					other.sendBinary(data)
				}
			}
			rm.mu.RUnlock()
			continue
		}
		var m struct {
			Type string          `json:"type"`
			To   string          `json:"to"`
			Data json.RawMessage `json:"data"`
			T    float64         `json:"t"`
		}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "ping":
			p.sendJSON(map[string]any{"type": "pong", "t": m.T})
		case "signal":
			signalMsgs.Add(1)
			rm.mu.RLock()
			target := rm.peers[m.To]
			rm.mu.RUnlock()
			if target != nil {
				target.sendJSON(map[string]any{"type": "signal", "from": id, "data": m.Data})
			} else {
				p.sendJSON(map[string]any{"type": "error", "code": "no_such_peer", "message": m.To})
			}
		}
	}
}

func mapPeers(ids []string) []map[string]string {
	out := make([]map[string]string, 0, len(ids))
	for _, id := range ids {
		out = append(out, map[string]string{"id": id})
	}
	return out
}

func handleMetrics(w http.ResponseWriter, _ *http.Request) {
	var ru syscall.Rusage
	syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	cpuS := float64(ru.Utime.Sec+ru.Stime.Sec) + float64(ru.Utime.Usec+ru.Stime.Usec)/1e6

	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	var roomCount, peerCount int
	rooms.Range(func(_, v any) bool {
		roomCount++
		r := v.(*room)
		r.mu.RLock()
		peerCount += len(r.peers)
		r.mu.RUnlock()
		return true
	})

	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"uptime_s":           time.Since(startedAt).Seconds(),
		"ws_connections":     peerCount,
		"rooms":              roomCount,
		"peers":              peerCount,
		"signal_msgs_total":  signalMsgs.Load(),
		"media_frames_total": mediaFrames.Load(),
		"media_bytes_total":  mediaBytes.Load(),
		"rss_bytes":          m.Sys,
		"cpu_s":              cpuS,
	})
}

func getEnv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	loadPubKey()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/signaling", handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/metrics", handleMetrics)
	log.Printf("[go_vc] ws://localhost:%s/v1/signaling", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
