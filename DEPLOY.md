Steps to attach `api.letter-tiles.com` to your backend and update DNS (safe, non-breaking)

1) Add custom domain to Render (backend)
- Open your Render dashboard → Services → letter-tiles-backend (web service).
- Settings → Custom Domains → Add Domain → enter: `api.letter-tiles.com`.
- Render will show a CNAME target (example: `gcp-xxxx.onrender.com` or similar).

2) Add DNS record in Cloudflare (or your registrar DNS)
- In Cloudflare DNS for `letter-tiles.com` add:
  - Type: CNAME
  - Name: `api`
  - Target / Content: the Render CNAME target shown in Render (e.g. `gcp-...onrender.com`)
  - TTL: Auto
  - Proxy status: **DNS only** (grey cloud) until Render verifies the domain.
- Wait a few minutes and click "Verify" in Render for the domain.

3) Verify API is reachable on the custom domain
- Once Render verifies the domain, run locally:

  curl -i https://api.letter-tiles.com/health

- Expected: HTTP 200 with JSON `{ "ok": true }`.

4) Update frontend to use the custom API domain
- The frontend now uses `REACT_APP_API_URL` env var or defaults to `https://api.letter-tiles.com`.
- To deploy the frontend to use this domain, set the environment variable in Render for the frontend (or build step):
  - `REACT_APP_API_URL=https://api.letter-tiles.com`
- Or allow the default (no env) and the client will use `https://api.letter-tiles.com`.

5) (Optional) Enable Cloudflare proxy
- After verification, you may set the Cloudflare record to proxied (orange cloud).
- In Cloudflare, set SSL/TLS → Full (strict).
- Ensure Page Rules bypass cache for socket and API paths (e.g. `/socket.io/*`, `/api/*`).

6) (Optional) Harden origin
- Restrict origin to Cloudflare IPs or add a secret header via a Cloudflare Worker.

Notes & rollback
- This change is non-breaking: the frontend will fallback to the Render onrender hostname if you set `REACT_APP_API_URL` to another value during testing.
- If anything goes wrong, revert the DNS CNAME or set the Cloudflare record back to DNS-only and the app will still work using the onrender host.

If you want, I can:
- Prepare a `git` commit that sets `REACT_APP_API_URL` in frontend build config, or
- Add a small `/debug` endpoint to the backend to return `req.realIP` and headers for verification, or
- Generate a Cloudflare Worker script for origin protection.

Tell me which next step you want me to take and I will apply it (and commit changes).
