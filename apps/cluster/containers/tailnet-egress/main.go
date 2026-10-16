// The PR review tailnet egress (see docs/pr-review.md): joins the tailnet as
// an ephemeral, tagged node with tsnet and forwards HTTP to one upstream
// origin, so the cluster Worker can reach a model endpoint that is only on
// the tailnet. It never forwards anywhere else.
//
// Environment:
//
//	TS_AUTHKEY       Tailscale OAuth client secret (or auth key). Required.
//	TS_TAGS          Comma-separated tags to advertise. Required with an OAuth client secret.
//	TS_HOSTNAME      The node's tailnet hostname. Defaults to "janitor".
//	UPSTREAM_ORIGIN  The only origin requests go to, e.g. https://proxy.example.ts.net. Required.
//	LISTEN_ADDR      Defaults to 0.0.0.0:8080.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	authKey := os.Getenv("TS_AUTHKEY")
	if authKey == "" {
		return errors.New("TS_AUTHKEY is not set")
	}
	// An OAuth client secret registers an ephemeral, pre-approved node.
	if strings.HasPrefix(authKey, "tskey-client-") && !strings.Contains(authKey, "?") {
		authKey += "?ephemeral=true&preauthorized=true"
	}
	upstream, err := url.Parse(os.Getenv("UPSTREAM_ORIGIN"))
	if err != nil || upstream.Scheme != "https" || upstream.Host == "" {
		return errors.New("UPSTREAM_ORIGIN must be an https origin")
	}
	hostname := envOr("TS_HOSTNAME", "janitor")
	listenAddr := envOr("LISTEN_ADDR", "0.0.0.0:8080")
	var tags []string
	for _, tag := range strings.Split(os.Getenv("TS_TAGS"), ",") {
		if tag = strings.TrimSpace(tag); tag != "" {
			tags = append(tags, tag)
		}
	}

	dir, err := os.MkdirTemp("", "tsnet-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	srv := &tsnet.Server{
		Hostname:      hostname,
		Dir:           dir,
		AuthKey:       authKey,
		Ephemeral:     true,
		AdvertiseTags: tags,
		// tsnet's own logs are verbose and may include node keys.
		Logf: func(string, ...any) {},
	}
	defer srv.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	upCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	start := time.Now()
	status, err := srv.Up(upCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("joining the tailnet: %w", err)
	}
	log.Printf("joined the tailnet as %s in %s", status.Self.DNSName, time.Since(start).Round(time.Millisecond))
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}

	transport := &http.Transport{
		// tsnet's Dial resolves names with the host's resolver, which doesn't
		// see the tailnet's split DNS, so names resolve through the tailnet.
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialViaTailnet(ctx, srv, lc, network, addr)
		},
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 5 * time.Minute,
		IdleConnTimeout:       90 * time.Second,
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(upstream)
			r.Out.Host = upstream.Host
		},
		Transport: transport,
		// Streamed completions pass through as they arrive.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// The error names hosts and addresses, never request content.
			log.Printf("forwarding %s %s failed: %v", r.Method, r.URL.Path, err)
			http.Error(w, "the tailnet egress could not reach the upstream", http.StatusBadGateway)
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", proxy)
	server := &http.Server{Addr: listenAddr, Handler: mux, ReadHeaderTimeout: 30 * time.Second}

	// Listening only after joining, so a passing health check means the
	// tailnet is up.
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	log.Printf("forwarding %s to %s", listenAddr, upstream.Host)

	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
	// Removes the ephemeral node now rather than after it times out.
	_ = lc.Logout(shutdown)
	return nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// resolve looks a name up through the tailnet's DNS, which includes its split
// DNS routes.
func resolve(ctx context.Context, lc *local.Client, host string) (string, error) {
	raw, _, err := lc.QueryDNS(ctx, host, "A")
	if err != nil {
		return "", err
	}
	var p dnsmessage.Parser
	if _, err := p.Start(raw); err != nil {
		return "", err
	}
	if err := p.SkipAllQuestions(); err != nil {
		return "", err
	}
	for {
		h, err := p.AnswerHeader()
		if err != nil {
			return "", fmt.Errorf("no A record for %s", host)
		}
		if h.Type != dnsmessage.TypeA {
			if err := p.SkipAnswer(); err != nil {
				return "", err
			}
			continue
		}
		a, err := p.AResource()
		if err != nil {
			return "", err
		}
		return net.IP(a.A[:]).String(), nil
	}
}

func dialViaTailnet(ctx context.Context, srv *tsnet.Server, lc *local.Client, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if net.ParseIP(host) == nil {
		if host, err = resolve(ctx, lc, host); err != nil {
			return nil, err
		}
	}
	return srv.Dial(ctx, network, net.JoinHostPort(host, port))
}
