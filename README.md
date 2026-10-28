# Lumi

<div align="center">
  <img src="public/lumi.svg" alt="Lumi logo" width="120">
</div>

<p align="center">
  English · <a href="README_CN.md">中文</a>
</p>

> **Lumi** is a cross-platform movie and TV discovery app built with **Next.js 15**, **Tailwind CSS**, and **TypeScript**. Its name nods to the Lumière brothers and cinema's earliest public screenings.

<div align="center">

![Next.js](https://img.shields.io/badge/Next.js-15-000?style=for-the-badge&logo=nextdotjs)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-3-e11d48?style=for-the-badge&logo=tailwindcss)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript)
![License](https://img.shields.io/github/license/Gerard-Devlin/Luma?style=for-the-badge)
![Docker Ready](https://img.shields.io/badge/Docker-ready-blue?style=for-the-badge&logo=docker)
![Cloudflare](https://img.shields.io/badge/Cloudflare-Worker-F38020?style=for-the-badge&logo=cloudflare&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-Powered-dc382d?style=for-the-badge&logo=redis&logoColor=white)
![TMDB](https://img.shields.io/badge/TMDB-Enhanced-01b4e4?style=for-the-badge)
![Stars](https://img.shields.io/github/stars/Gerard-Devlin/Luma?style=for-the-badge&logo=github&logoColor=white&color=881337)

</div>

---

## Features

- 🔎 **Multi-source search**: Search across configured providers and get aggregated results in one place.
- 🎬 **TMDB metadata enrichment**: Posters, backdrops, ratings, cast, collections, and recommendations.
- 🌐 **Multilingual interface**: Switch between English and Chinese, with TMDB requests following the selected language.
- 🧠 **Personalized recommendation engine**: Build watch-history-aware discovery rails from TMDB recommendations, similar titles, keywords, credits, and ranking signals.
- 🍿 **Movie and TV discovery**: Browse movies, series, curated categories, years, ratings, and runtime filters.
- ⭐ **Favorites and continue watching**: Save favorites, watch history, playback progress, and resume points.
- 🗄️ **Flexible server storage**: localStorage, Redis, Cloudflare D1, and Upstash Redis.
- 🔒 **No-account browsing**: No login or registration; favorites, watch history, and playback progress stay in your browser.
- 📱 **PWA ready**: Offline cache, home-screen installation, and a mobile-friendly experience.
- 🖥️ **Responsive layout**: Desktop sidebar, mobile bottom navigation, and large-screen content rails.

## Screenshots

<p align="center">
  <img src="public/screenshot1.png" alt="Lumi home recommendations" width="820">
</p>
<p align="center">
  <img src="public/screenshot2.png" alt="Lumi content rails" width="820">
</p>
<p align="center">
  <img src="public/screenshot3.png" alt="Lumi hero carousel" width="820">
</p>

## Quick Start

```bash
pnpm install
pnpm dev
```

The development server runs at `http://localhost:3000` by default.

## Deployment

For Docker, Vercel, Cloudflare Workers, storage backends, and environment variables, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Tech Stack

| Area               | Main Dependencies                                                         |
| ------------------ | ------------------------------------------------------------------------- |
| Framework          | [Next.js 15](https://nextjs.org/) App Router                              |
| UI and Styling     | [Tailwind CSS 3](https://tailwindcss.com/), next-themes, Framer Motion    |
| Language           | TypeScript 5                                                              |
| Data and Storage   | localStorage, Redis, Cloudflare D1, Upstash Redis                         |
| Personal Data      | Browser localStorage for favorites, search history, and watch progress    |
| Content Enrichment | TMDB API, category feeds, image proxy                                     |
| Code Quality       | ESLint, Prettier, Jest                                                    |
| Deployment         | Docker, Vercel, Cloudflare Workers, OpenNext                              |

## License

[Apache-2.0](LICENSE) (c) 2026 Lumi Contributors

## Developer

[Bit](https://t.me/decimalvalue) — Telegram: [@decimalvalue](https://t.me/decimalvalue)

## Acknowledgements

<img src="public/TMDB_Green.svg" alt="TMDB Logo" width="120">

- [Next.js](https://nextjs.org/) and [Tailwind CSS](https://tailwindcss.com/): The application framework and styling foundation.
- Thanks to the maintainers of the open-source projects, metadata services, and provider APIs that make this project possible.
