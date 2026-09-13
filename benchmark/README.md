# Adaptive Learning Webapp Benchmark Suite

This directory contains scripts to stress test and find bottlenecks in the Adaptive Learning application. It specifically uses `aiohttp` to perform load testing that correctly accesses authentication cookies and handles NextAuth's CSRF architecture natively.

## Setup Requirements

Ensure you have `uv` set up in your terminal, then install the local requirements:

```bash
uv pip install aiohttp
```

## Running the Load Tests

We have added a custom `--url` flag to easily target different environments (local vs. Cloudflare tunnel). Before running these, make sure the Next.js server is actively running.

### 1. Local Testing

When testing against your un-tunneled development database, you can leave the URL unspecified since it defaults to `http://localhost:3000`.

```bash
# Simulates 50 concurrent connections blasting 500 API calls 
uv run benchmark/load_test.py \
  --username "teacherUser" \
  --password "yourpassword" \
  --endpoint "/api/classes" \
  -c 50 \
  -n 500
```

### 2. Remote Testing (via Cloudflared Tunnel)

To test your public-facing throughput exactly as external users would experience it over the remote domain. Be sure to specify your active Cloudflare HTTPS URL.

```bash
uv run benchmark/load_test.py \
  --url "https://dev.ai4talent.org" \
  --username "teacherUser" \
  --password "yourpassword" \
  --endpoint "/api/classes" \
  -c 50 \
  -n 500
```
> **Note**: Modify `https://dev.ai4talent.org` to whatever host your `cloudflared` tunnel is currently surfacing.
>
> 🚨 **Cloudflare WAF Blocking Note** 🚨
> If you are testing against a Cloudflare-proxied domain and your script outputs "Login attempt rejected! Status: 403", Cloudflare's Web Application Firewall (WAF) is likely identifying your script's rapid load-testing attempts as a bot/DDoS attack and dropping the requests.
>
> **To fix this and whitelist your testing script:**
> 1. Get your server's current public IP address (e.g., `curl ifconfig.me`).
> 2. Log into the [Cloudflare Dashboard](https://dash.cloudflare.com).
> 3. Go to your domain -> **Security** -> **WAF** -> **Tools**.
> 4. Create an **IP Access Rule**:
>    - Value: `<Your Public IP>`
>    - Action: `Allow`
>    - Zone: `This Website`
> 5. Wait ~60 seconds and re-run the benchmark script.

---

### Load Script Arguments Reference:
- `--url`: Base URL the test should run against (default: `http://localhost:3000`)
- `--username`: The registered username or email to perform the load test under
- `--password`: Password for the account
- `-c`, `--concurrency`: How many simultaneous workers should generate load (default: 10)
- `-n`, `--requests`: Maximum total combined requests pushed to the DB (default: 100)
