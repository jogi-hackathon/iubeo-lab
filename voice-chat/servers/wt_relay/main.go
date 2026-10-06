// WT relay — WebTransport-over-HTTP/3 media relay for the bench.
// Signaling stays on the contract WS server; this process only relays
// opaque media frames between sessions in the same room (by JWT claim).
//
//   QUIC:  https://localhost:8090/v1/media?token=...   (WebTransport upgrade)
//   ctrl:  http://localhost:8091/{healthz,metrics,wtcert}
//
// /wtcert returns {"url","hash"} — the harness passes both to the page so
// Chrome can connect with serverCertificateHashes (self-signed dev cert).
package main

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

var (
	startedAt   = time.Now()
	mediaFrames atomic.Int64
	mediaBytes  atomic.Int64
	roomMax     = 8
	port        = getEnv("PORT", "8090")
	ctrlPort    = getEnv("CTRL_PORT", "8091")
	jwtPubKey   ed25519.PublicKey
	certHashB64 string
	wtURL       = getEnv("WT_URL", "https://localhost:8090/v1/media")
)

// ---------- dev cert (self-signed, <=14 days for serverCertificateHashes) ----------

func devCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: "vc-bench-wt"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 24 * time.Hour),
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	sum := sha256.Sum256(der)
	certHashB64 = base64.StdEncoding.EncodeToString(sum[:])
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// ---------- JWT (EdDSA) verify — same contract as go_vc ----------

func loadPubKey() {
	path := os.Getenv("VC_PUBLIC_KEY_PATH")
	if path == "" {
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

// ---------- rooms (WT sessions) ----------

type session struct {
	id   string
	sess *webtransport.Session
}

type room struct {
	mu    sync.RWMutex
	peers map[string]*session
}

var rooms sync.Map // roomID -> *room

func joinRoom(roomID, id string, sess *webtransport.Session) (*room, bool) {
	ri, _ := rooms.LoadOrStore(roomID, &room{peers: map[string]*session{}})
	r := ri.(*room)
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.peers[id]; dup || len(r.peers) >= roomMax {
		return nil, false
	}
	r.peers[id] = &session{id: id, sess: sess}
	return r, true
}

func (r *room) leave(roomID, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, id)
	if len(r.peers) == 0 {
		rooms.Delete(roomID)
	}
}

func (r *room) relay(from string, d []byte) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.peers {
		if p.id != from {
			// SendDatagram blocks while the per-session queue is full; a full
			// queue means the peer is hopelessly behind — drop is correct.
			go p.sess.SendDatagram(d) //nolint:errcheck
		}
	}
}

// ---------- handlers ----------

var wtServer *webtransport.Server

func handleMedia(w http.ResponseWriter, r *http.Request) {
	c, err := verifyJWT(r.URL.Query().Get("token"))
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	sess, err := wtServer.Upgrade(w, r)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	rm, ok := joinRoom(c.Room, c.Sub, sess)
	if !ok {
		sess.CloseWithError(4413, "room full or duplicate id")
		return
	}
	defer rm.leave(c.Room, c.Sub)
	defer sess.CloseWithError(0, "bye")

	ctx := sess.Context()
	for {
		d, err := sess.ReceiveDatagram(ctx)
		if err != nil {
			return
		}
		mediaFrames.Add(1)
		mediaBytes.Add(int64(len(d)))
		rm.relay(c.Sub, d)
	}
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
		"ws_connections":     0,
		"rooms":              roomCount,
		"peers":              peerCount,
		"signal_msgs_total":  0,
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
	cert, err := devCert()
	if err != nil {
		log.Fatalf("cert: %v", err)
	}

	wtServer = &webtransport.Server{
		H3: &http3.Server{
			Addr:      ":" + port,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
				NextProtos:   []string{"h3"},
			},
			QUICConfig: &quic.Config{
				EnableDatagrams:        true,
				MaxIncomingStreams:     100,
				MaxIncomingUniStreams:  100,
				KeepAlivePeriod:        10 * time.Second,
				MaxIdleTimeout:         60 * time.Second,
				InitialStreamReceiveWindow:     1 << 20,
				InitialConnectionReceiveWindow: 4 << 20,
			},
		},
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	http.DefaultServeMux.HandleFunc("/v1/media", handleMedia)

	// ctrl listener (plain HTTP): health/metrics/cert-hash discovery
	cors := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("access-control-allow-origin", "*")
			h(w, r)
		}
	}
	ctrl := http.NewServeMux()
	ctrl.HandleFunc("/healthz", cors(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	ctrl.HandleFunc("/metrics", cors(handleMetrics))
	ctrl.HandleFunc("/wtcert", cors(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"url": wtURL, "hash": certHashB64})
	}))
	go func() {
		log.Printf("[wt_relay] ctrl http://localhost:%s {healthz,metrics,wtcert}", ctrlPort)
		log.Fatal(http.ListenAndServe(":"+ctrlPort, ctrl))
	}()

	log.Printf("[wt_relay] wt %s (cert sha256 %s)", wtURL, certHashB64)
	log.Fatal(wtServer.ListenAndServe())
}
