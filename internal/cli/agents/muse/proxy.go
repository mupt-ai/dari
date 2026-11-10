package muse

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/mupt-ai/dari/internal/cli/agents"
)

// statusProxy forwards Muse Code to the router and reports the routing status
// of each reply to the main agent.
type statusProxy struct {
	listener net.Listener
	server   *http.Server
	done     chan struct{}
}

func newStatusProxy(key, baseURL string, report func(agents.Status)) (*statusProxy, error) {
	target, err := url.Parse(baseURL)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return nil, fmt.Errorf("invalid Muse Code routing endpoint")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen for Muse Code routing proxy: %w", err)
	}
	routerPath := strings.TrimSuffix(target.Path, "/")
	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			// Muse Code reads its model list from the origin; the router serves
			// it under its own path.
			request.Out.URL.Path = routerPath + request.In.URL.Path
			request.Out.URL.RawPath = ""
			request.Out.URL.Scheme = target.Scheme
			request.Out.URL.Host = target.Host
			request.Out.Host = target.Host
		},
		FlushInterval: -1,
		ModifyResponse: func(response *http.Response) error {
			if status, ok := mainAgentStatus(response); ok {
				report(status)
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "Dari routing upstream unavailable", http.StatusBadGateway)
		},
	}
	p := &statusProxy{
		listener: listener,
		done:     make(chan struct{}),
		server: &http.Server{
			ReadHeaderTimeout: 10 * time.Second,
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// Only Muse Code, holding the routing key, may use the proxy.
				if r.Header.Get("Authorization") != "Bearer "+key {
					http.Error(w, "Unauthorized", http.StatusUnauthorized)
					return
				}
				if !strings.HasPrefix(r.URL.Path, "/v1/") && r.URL.Path != "/muse-code/models" {
					http.NotFound(w, r)
					return
				}
				proxy.ServeHTTP(w, r)
			}),
		},
	}
	go func() {
		defer close(p.done)
		_ = p.server.Serve(listener)
	}()
	return p, nil
}

// mainAgentStatus is the routing status of a successful model reply to Muse
// Code's main agent. Its reminder observers and subagents tag themselves with
// other roles and must not replace it.
func mainAgentStatus(response *http.Response) (agents.Status, bool) {
	request := response.Request
	if response.StatusCode < 200 || response.StatusCode >= 300 ||
		request.Method != http.MethodPost || !strings.HasSuffix(request.URL.Path, "/responses") {
		return agents.Status{}, false
	}
	if role := request.Header.Get("x-tbh-agent-role"); role != "" && role != "main" {
		return agents.Status{}, false
	}
	status := agents.StatusFromHeaders(response.Header)
	return status, status.String() != ""
}

func (p *statusProxy) url() string {
	return "http://" + p.listener.Addr().String()
}

func (p *statusProxy) close() {
	_ = p.server.Close()
	<-p.done
}
