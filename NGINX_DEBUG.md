# Nginx Reverse Proxy - Domain Name Headers

## Headers That Contain Domain Information

When nginx acts as a reverse proxy, it can forward the original request information via these headers:

### 1. **Host** header (standard)
- Contains: The domain name and port from the original request
- Example: `example.com` or `example.com:443`
- This is automatically set by nginx

### 2. **X-Forwarded-Host** (proxy-specific)
- Contains: The original Host header value before proxying
- Example: `example.com`
- Must be explicitly set in nginx config

### 3. **X-Forwarded-Proto** (proxy-specific)
- Contains: The protocol used by the client (http or https)
- Example: `https`
- Must be explicitly set in nginx config

### 4. **X-Forwarded-Port** (proxy-specific)
- Contains: The port the client connected to
- Example: `443` or `80`
- Must be explicitly set in nginx config

## Recommended Nginx Configuration

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    # SSL configuration
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        # Forward to your Node.js server
        proxy_pass http://localhost:3000;
        
        # Essential headers for domain detection
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        
        # Optional: increase timeouts for video uploads
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        client_max_body_size 100M;
    }
}

# Redirect HTTP to HTTPS (optional but recommended)
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

## How to Test

1. Start your Node.js server with the updated logging
2. Make a request to your domain through nginx
3. Check the console logs - you should see output like:

```
[getBaseUrl] Headers received:
  X-Forwarded-Proto: https
  X-Forwarded-Host: your-domain.com
  X-Forwarded-Port: 443
  Host: your-domain.com
  ctx.protocol: http
  ctx.host: localhost:3000
  ctx.hostname: localhost
  ctx.origin: http://localhost:3000
  ctx.href: http://localhost:3000/video/sessions
[getBaseUrl] Constructed base URL: https://your-domain.com
```

## Common Issues

### Issue: Getting `http://localhost:3000` instead of actual domain

**Cause**: Nginx isn't forwarding the proxy headers

**Solution**: Add the `proxy_set_header` directives to your nginx config (see above)

### Issue: Getting `http://` instead of `https://`

**Cause**: `X-Forwarded-Proto` header is not set or incorrect

**Solution**: Add `proxy_set_header X-Forwarded-Proto $scheme;` to nginx config

### Issue: Port number appearing when it shouldn't

**Cause**: Host header includes port, or X-Forwarded-Port needs handling

**Solution**: The updated `getBaseUrl` function should handle this, but you may need to strip the port from the Host header

## Next Steps

After adding the logging:

1. Make a test request through your nginx proxy
2. Check the server console logs
3. Share the log output if you need help diagnosing the issue
4. Once working correctly, you can remove or reduce the logging

