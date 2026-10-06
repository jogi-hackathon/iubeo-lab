// peerhash dials a QUIC endpoint and prints the SHA-256 fingerprint of its
// leaf certificate (hex), for use with browser serverCertificateHashes.
package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	quic "github.com/quic-go/quic-go"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: peerhash <host:port>")
		os.Exit(2)
	}
	conn, err := quic.DialAddr(context.Background(), os.Args[1],
		&tls.Config{InsecureSkipVerify: true, NextProtos: []string{"h3"}},
		&quic.Config{HandshakeIdleTimeout: 3 * time.Second})
	if err != nil {
		fmt.Fprintln(os.Stderr, "dial:", err)
		os.Exit(1)
	}
	defer conn.CloseWithError(0, "")
	cs := conn.ConnectionState().TLS
	if len(cs.PeerCertificates) == 0 {
		fmt.Fprintln(os.Stderr, "no peer cert")
		os.Exit(1)
	}
	sum := sha256.Sum256(cs.PeerCertificates[0].Raw)
	fmt.Println(hex.EncodeToString(sum[:]))
	c := cs.PeerCertificates[0]
	fmt.Println("subject:", c.Subject, "dns:", c.DNSNames, "nb:", c.NotBefore, "na:", c.NotAfter)
}
