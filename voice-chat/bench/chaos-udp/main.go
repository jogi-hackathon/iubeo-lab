// chaos-udp — UDP proxy with delay/jitter/loss injection (host-side netem).
// Used to impair QUIC/WebTransport traffic without docker UDP forwarding.
//   -listen :18090 -target 127.0.0.1:8090 -delay 50 -jitter 10 -loss 5
package main

import (
	"crypto/rand"
	"flag"
	"log"
	"math/big"
	"net"
	"sync"
	"time"
)

var (
	listen = flag.String("listen", ":18090", "listen addr")
	target = flag.String("target", "127.0.0.1:8090", "upstream addr")
	delay  = flag.Float64("delay", 0, "base delay ms")
	jitter = flag.Float64("jitter", 0, "uniform jitter ms")
	loss   = flag.Float64("loss", 0, "drop probability %")
)

func rnd() float64 {
	n, _ := rand.Int(rand.Reader, big.NewInt(1<<30))
	return float64(n.Int64()) / (1 << 30)
}

func shape() (drop bool, d time.Duration) {
	if *loss > 0 && rnd()*100 < *loss {
		return true, 0
	}
	return false, time.Duration((*delay + rnd()**jitter) * float64(time.Millisecond))
}

// each client gets a dedicated upstream socket so replies route correctly
var (
	mu      sync.Mutex
	socks   = map[string]*net.UDPConn{}
	dst     *net.UDPAddr
	ln      *net.UDPConn
)

func upstreamFor(src *net.UDPAddr) (*net.UDPConn, error) {
	mu.Lock()
	defer mu.Unlock()
	if s, ok := socks[src.String()]; ok {
		return s, nil
	}
	s, err := net.DialUDP("udp", nil, dst)
	if err != nil {
		return nil, err
	}
	socks[src.String()] = s
	// upstream -> this client
	go func() {
		buf := make([]byte, 1<<16)
		for {
			n, err := s.Read(buf)
			if err != nil {
				return
			}
			drop, d := shape()
			if drop {
				continue
			}
			b := append([]byte(nil), buf[:n]...)
			time.AfterFunc(d, func() { ln.WriteToUDP(b, src) })
		}
	}()
	return s, nil
}

func main() {
	flag.Parse()
	var err error
	dst, err = net.ResolveUDPAddr("udp", *target)
	if err != nil {
		log.Fatal(err)
	}
	laddr, err := net.ResolveUDPAddr("udp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	ln, err = net.ListenUDP("udp", laddr)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("[chaos-udp] %s -> %s delay=%.0fms jitter=%.0fms loss=%.1f%%", *listen, *target, *delay, *jitter, *loss)

	buf := make([]byte, 1<<16)
	for {
		n, src, err := ln.ReadFromUDP(buf)
		if err != nil {
			return
		}
		up, err := upstreamFor(src)
		if err != nil {
			continue
		}
		// uplink unimpaired — matches docker netem (server egress only)
		b := append([]byte(nil), buf[:n]...)
		up.Write(b)
	}
}
