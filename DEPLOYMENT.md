# Deployment

This guide covers Docker, Docker Compose, Vercel, Cloudflare Workers, storage backends, and runtime environment variables for Lumi.

## Supported Targets

Lumi supports Docker, Vercel, and Cloudflare Workers. The site has no login or registration; favorites and watch history are stored in each visitor's browser and are not synced between devices.

## HTTPS for Playback

Playback providers that use browser cryptography require a secure context. Serve Lumi over HTTPS with a trusted certificate, especially when opening it on a phone. Accessing a server through an HTTP LAN IP (for example, `http://192.168.1.10:3000`) disables browser cryptography required by some providers. `localhost` is treated as secure for local development, but that exception does not apply to other devices.

| Storage Backend |     Docker     |     Vercel     | Cloudflare Workers |
| :-------------: | :------------: | :------------: | :----------------: |
|  localStorage   |   Supported    |   Supported    |     Supported      |
|      Redis      |   Supported    | Not applicable |   Not applicable   |
|  Cloudflare D1  | Not applicable | Not applicable |     Supported      |
|  Upstash Redis  |   Supported    |   Supported    |     Supported      |

## Progressive Web App

The production build includes an installable web app, a service worker, offline
navigation fallback, and update prompts. On supported browsers, choose **Install
Lumi** to open the browser's native app-install prompt; this installs Lumi as a
standalone web app, not a bookmark. iOS Safari uses **Share → Add to Home Screen**
to install the web app. Browsers control whether installation is available, so
Lumi cannot silently install itself. The site must be served over HTTPS (or
localhost for development), and the first visit must be online so the service
worker can install and cache the app shell.

Previously visited pages and static app assets may be available offline. TMDB
metadata, search, recommendations, and streaming sources still require a network
connection; video and API responses are deliberately never cached. On iOS, use
Safari's **Share → Add to Home Screen**. In-app browsers may not offer PWA
installation.

## Vercel

1. Fork this repository to your GitHub account.
2. Open [Vercel](https://vercel.com/), choose **Add New Project**, and import the forked repository.
3. Add `TMDB_API_KEY` in **Project Settings → Environment Variables** for each environment you deploy. Keep this key server-side; do not use the `NEXT_PUBLIC_` prefix.
4. Keep the default Next.js build settings and deploy. Vercel provides HTTPS on its deployment domains; use the HTTPS URL for playback.
5. To use Upstash Redis for server-side storage, also set `NEXT_PUBLIC_STORAGE_TYPE=upstash`, `UPSTASH_URL`, and `UPSTASH_TOKEN`.

## Cloudflare Workers

This project uses the OpenNext Cloudflare runtime. The included `wrangler.jsonc` can be used as a reference configuration.

```bash
pnpm install --frozen-lockfile
pnpm run build:worker
pnpm run deploy:worker
```

When using Cloudflare D1:

1. Create a D1 database in the Cloudflare dashboard.
2. Run [D1_SCHEMA.md](D1_SCHEMA.md) against the database.
3. Bind the database in `wrangler.jsonc` and keep the binding name as `DB`.
4. Set `NEXT_PUBLIC_STORAGE_TYPE=d1`.

## Docker

The single-container image includes the app and an embedded Redis instance, which is convenient for personal servers.

```bash
cp .env.docker.example .env.docker
docker build -f Dockerfile.single -t luma:single .
docker run -d --name luma -p 3000:3000 --env-file .env.docker -v luma_data:/data luma:single
```

Then open `http://SERVER_IP:3000`. Make sure port `3000` is allowed by your firewall or hosting provider.

## Docker Compose

The recommended path is to use the Compose files included in this repository.

```bash
cp .env.docker.example .env.docker
docker compose -f docker-compose.single.yml up -d
```

Single-container deployment with embedded Redis:

```yaml
services:
  luma:
    image: ${LUMA_IMAGE:-luma:single}
    container_name: luma
    restart: unless-stopped
    ports:
      - '3000:3000'
    env_file:
      - .env.docker
    environment:
      DOCKER_ENV: 'true'
      NEXT_PUBLIC_STORAGE_TYPE: redis
      REDIS_URL: redis://127.0.0.1:6379
    volumes:
      - redis-data-single:/data
```

Two-container deployment with a separate Redis service:

```bash
docker compose up -d
```

```yaml
services:
  luma:
    image: ${LUMA_IMAGE:-luma:multi}
    container_name: luma
    restart: unless-stopped
    ports:
      - '3000:3000'
    env_file:
      - .env.docker
    environment:
      NEXT_PUBLIC_STORAGE_TYPE: redis
      REDIS_URL: redis://luma-redis:6379
      DOCKER_ENV: 'true'
    depends_on:
      - luma-redis

  luma-redis:
    image: redis:7-alpine
    container_name: luma-redis
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes']
    volumes:
      - redis-data:/data
```

## Environment Variables

| Variable                   | Description                       | Accepted Values                          | Default                |
| -------------------------- | --------------------------------- | ---------------------------------------- | ---------------------- |
| `SITE_NAME`                | Site name                         | Any string                               | `Lumi`                 |
| `ANNOUNCEMENT`             | Site announcement                 | Any string                               | Built-in safety notice |
| `NEXT_PUBLIC_STORAGE_TYPE` | Server-side storage backend       | `localstorage`, `redis`, `d1`, `upstash` | `localstorage`         |
| `REDIS_URL`                | Redis connection URL              | Redis URL                                | Empty                  |
| `UPSTASH_URL`              | Upstash Redis REST URL            | URL                                      | Empty                  |
| `UPSTASH_TOKEN`            | Upstash Redis token               | Token                                    | Empty                  |
| `TMDB_API_KEY`             | Server-side TMDB API key          | TMDB key                                 | Empty                  |
| `NEXT_PUBLIC_TMDB_API_KEY` | Client-side fallback TMDB API key | TMDB key                                 | Empty                  |
| `TMDB_API_BASE_URL`        | TMDB API proxy base URL           | URL                                      | Official TMDB API      |

## Personal Data

Favorites, search history, and watch progress are saved in the browser's localStorage. They are not associated with an account and will not sync to another browser or device.

- **Clear browser data**: Clearing site data removes the locally saved library and watch history.
- **Follow local laws**: Make sure your deployment and usage comply with your local regulations.

### Important Notice

- This project is intended for learning, research, and personal use only.
- This project does not store video files. Metadata comes from TMDB, and playback uses the configured TMDB player embed.
- Do not use deployed instances for commercial services or public distribution.
- Users are responsible for any risk caused by deployment, sharing, or usage.
