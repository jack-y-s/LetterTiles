Nginx example for serving static assets (gzip/brotli + caching):

server {
  listen 80;
  server_name example.com;

  root /var/www/letter-tiles/frontend/dist;

  # Serve pre-compressed Brotli if available
  brotli on;
  brotli_static on;

  gzip on;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri $uri/ =404;
  }

  location = /index.html {
    add_header Cache-Control "public, max-age=0, must-revalidate";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}

Cloudflare/ CDN recommendations:
- Enable Brotli compression and HTTP/2/3.
- Cache static assets (/*/assets/*) aggressively; set Edge TTL to 1 year and use origin cache-control for revalidation.
- Use Cache-Control: immutable for fingerprinted assets.

Notes:
- Ensure your build step generates brotli files (e.g., use `brotli` or `compression-webpack-plugin` equivalent) and upload them alongside the regular assets to the CDN or configure your server to compress on-the-fly.
 - Ensure your build step generates brotli files (we added `scripts/precompress.js`) and upload them alongside the regular assets to the CDN or configure your server to compress on-the-fly.

Nginx example to serve pre-compressed files when available and set correct headers:

server {
  listen 80;
  server_name example.com;
  root /var/www/letter-tiles/frontend/dist;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    # Prefer brotli when client accepts it
    set $br "";
    if ($http_accept_encoding ~* "br") {
      set $br ".br";
    }
    try_files $uri$br $uri.gz $uri =404;
    # If serving precompressed file, set encoding header
    gzip_static on;
    brotli_static on;
    if ($br = ".br") {
      add_header Content-Encoding br;
    }
  }

  location /index.html {
    add_header Cache-Control "public, max-age=0, must-revalidate";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
- Long-term caching requires fingerprinted filenames (Vite already emits hashed filenames).
