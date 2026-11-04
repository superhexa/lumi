                      


import os
import re
import sys
import time
import json
import html
import urllib.request
import urllib.parse
import urllib.error

import video_engine

BASE = "https://yts.gg"
DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "torrents")
VIDEOS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "downloads")

USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0")

CHALLENGE_MARKERS = (
    b"Just a moment",
    b"__cf_chl_",
    b"Attention Required",
    b"cf-chl-bypass",
    b"cf-challenge",
)


RESOLUTIONS = ["2160p", "1080p", "720p", "3D"]


class YTSClient:
    def __init__(self, cookie=None, timeout=30):
        self.timeout = timeout
        self.cookie = cookie or os.environ.get("YTS_COOKIE") or ""
        self._scraper = None
        self.headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE + "/browse-movies",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
            "Alt-Used": "yts.gg",
        }

    def _headers_for(self, referer=None):
        h = dict(self.headers)
        if self.cookie:
            h["Cookie"] = self.cookie
        if referer:
            h["Referer"] = referer
        return h

    @staticmethod
    def _looks_like_challenge(body):
        if not body:
            return False
        head = body[:4000]
        return any(m in head for m in CHALLENGE_MARKERS)

    def _direct(self, url, h):
        req = urllib.request.Request(url, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read()
                resp_headers = dict(resp.headers)
                final_url = resp.geturl()
                status = resp.status
        except urllib.error.HTTPError as e:
            return e.code, b"", {}, url
        sc = resp_headers.get("Set-Cookie") or ""
        m = re.search(r"(?:cf_clearance|PHPSESSID)=[^;]+", sc)
        if m and not self.cookie:
            self.cookie = m.group(0)
        return status, body, resp_headers, final_url

    def _curl(self, url, h):
        try:
            from curl_cffi import requests as cc_req
        except Exception:
            return None
        try:
            r = cc_req.get(url, headers=h, timeout=self.timeout, impersonate="chrome")
        except Exception:
            return None
        try:
            self.cookie = "; ".join("%s=%s" % (k, v) for k, v in r.cookies.items()) or self.cookie
        except Exception:
            pass
        return r.status_code, r.content, dict(r.headers), str(r.url)

    def _cs(self, url, h):
        try:
            import cloudscraper
        except ImportError:
            return None
        if self._scraper is None:
            self._scraper = cloudscraper.create_scraper(
                browser={"browser": "firefox", "platform": "linux", "desktop": True})
        try:
            r = self._scraper.get(url, headers=h, timeout=60)
        except Exception:
            return None
        try:
            d = r.cookies.get_dict()
            if d:
                self.cookie = "; ".join("%s=%s" % (k, v) for k, v in d.items())
        except Exception:
            pass
        return r.status_code, r.content, dict(r.headers), r.url

    def _flare(self, url, h):
        base = os.environ.get("FLARESOLVERR_URL")
        if not base:
            return None
        payload = {"cmd": "request.get", "url": url, "maxTimeout": 60000}
        try:
            req = urllib.request.Request(
                base.rstrip("/") + "/v1",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=80) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        if data.get("status") != "ok":
            return None
        sol = data.get("solution") or {}
        if sol.get("userAgent"):
            self.user_agent = sol["userAgent"]
            self.headers["User-Agent"] = self.user_agent
        cks = sol.get("cookies") or []
        if cks:
            self.cookie = "; ".join("%s=%s" % (c.get("name"), c.get("value")) for c in cks if c.get("name"))
        body = (sol.get("response") or "").encode("utf-8")
        return 200, body, {}, url

    def get(self, url, referer=None):
        h = self._headers_for(referer)
        errors = []
        for attempt in (self._direct, self._curl, self._cs, self._flare):
            name = getattr(attempt, "__name__", "?")
            try:
                got = attempt(url, h)
            except Exception as e:
                errors.append("%s: %s" % (name, e))
                continue
            if got is None:
                errors.append("%s: engine not available" % name)
                continue
            status, body, resp_headers, final_url = got
            if status == 200 and not self._looks_like_challenge(body):
                return body, resp_headers, final_url
            errors.append("%s: HTTP %s%s" % (name, status,
                          " (cloudflare challenge)" if self._looks_like_challenge(body) else ""))
        manual = os.environ.get("YTS_COOKIE")
        if manual and self.cookie != manual:
            self.cookie = manual
            try:
                status, body, resp_headers, final_url = self._direct(url, self._headers_for(referer))
                if status == 200 and not self._looks_like_challenge(body):
                    return body, resp_headers, final_url
                errors.append("YTS_COOKIE: HTTP %s" % status)
            except Exception as e:
                errors.append("YTS_COOKIE: %s" % e)
        raise RuntimeError("Cloudflare blocked all automatic strategies for %s:\n  %s"
                           % (url, "\n  ".join(errors[-4:])))

    def get_html(self, url, referer=None):
        body, _, _ = self.get(url, referer=referer)
        return body.decode("utf-8", errors="replace")

                                                                             
    def browse(self, page=1, quality=None):
        if quality and quality != "0":
                                                                           
                                                                                       
            pnr = max(0, page - 1)
            url = "%s/browse-movies/0/%s/all/0/latest/%d/all" % (BASE, quality, pnr)
        else:
            url = "%s/browse-movies?page=%d" % (BASE, page)
        return self._parse_movie_list(self.get_html(url), url)

    def search(self, query, quality=None):
        term = urllib.parse.quote_plus(query.strip())
        q = quality if quality and quality != "0" else "all"
        url = "%s/browse-movies/%s/%s/all/0/latest/0/all" % (BASE, term, q)
        return self._parse_movie_list(self.get_html(url), url)

    @staticmethod
    def _parse_movie_list(page_html, url):
        cards = re.findall(
            r'<div class="browse-movie-wrap[^"]*">.*?'
            r'<a href="(https://yts\.gg/movies/[^"]+)" class="browse-movie-link">.*?'
            r'<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)".*?'
            r'</figure>.*?'
            r'class="browse-movie-title">(.*?)</a>.*?'
            r'class="browse-movie-year">([^<]*)</div>',
            page_html,
            re.S,
        )
        movies = []
        for url_, img, _alt, title_raw, year in cards:
            title = re.sub(r"<span[^>]*>.*?</span>", "", title_raw, flags=re.S)                  
            title = html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", title))).strip()
            rating = ""
            if rating_m := re.search(r'<h4 class="rating">([^<]*) / 10</h4>', page_html):
                pass                                              
            movies.append(
                {
                    "url": url_,
                    "title": title,
                    "year": year.strip(),
                    "poster": img,
                    "rating": "",
                }
            )
                                                                     
        blocks = re.findall(
            r'<div class="browse-movie-wrap[^"]*">.*?</div>\s*</div>',
            page_html,
            re.S,
        )
        for i, block in enumerate(blocks[: len(movies)]):
            m = re.search(r'<h4 class="rating">([\d.]+)\s*/\s*10</h4>', block)
            if m:
                movies[i]["rating"] = m.group(1)
        return {"url": url, "movies": [m for m in movies if m["title"]]}

                                                                              
    def movie_detail(self, movie_url):
        html_text = self.get_html(movie_url, referer=BASE + "/browse-movies")
        info = {"detail_url": movie_url, "torrents": [], "magnet": ""}

        m = re.search(r'<h1 itemprop="name">(.*?)</h1>', html_text, re.S)
        if m:
            info["title"] = html.unescape(m.group(1)).strip()
                                                                         
                                                                              
            tail = html_text[m.end(): m.end() + 400]
            ym = re.search(r"<h2[^>]*>\s*(\d{4})\s*(?:<|/)", tail)
            info["year"] = ym.group(1) if ym else ""
        m = re.search(r'id="mobile-movie-info"[^>]*>\s*<h1[^>]*>.*?</h1>\s*<h2>\d{4}</h2>\s*<h2>(.*?)</h2>', html_text, re.S)
        info["genres"] = [g.strip() for g in m.group(1).split("/")] if m else []
        m = re.search(r"<span class=\"icon-star\"></span>\s*<h4 class=\"rating\">([\d.]+)\s*/\s*10", html_text)
        info["rating"] = m.group(1) if m else ""

        m = re.search(r'<img[^>]+itemprop="image"[^>]+src="([^"]+)"', html_text)
        info["poster"] = m.group(1) if m else ""

                       
        m = re.search(r'id="movie-tech-info".*?<p>(.*?)</p>', html_text, re.S)
        info["summary"] = ""
        if m:
            txt = re.sub(r"<br\s*/?>", "\n", m.group(1))
            info["summary"] = html.unescape(re.sub(r"<[^>]+>", "", txt)).strip()

                                                                   
        chunks = re.split(r'<div class="modal-torrent">', html_text)[1:]
        if chunks:
                                                                     
                                                                          
            cut = re.search(r'\n {24}</div>', chunks[-1])
            if cut:
                chunks[-1] = chunks[-1][: cut.start()]
        for block in chunks:
            q = re.search(r'id="modal-quality-[^"]*"><span>([^<]*)</span>', block)
            link = re.search(r'<a class="download-torrent[^"]*" href="([^"]+)"', block)
            mag = re.search(r'data-torrent-id="\d+" href="(magnet:\?[^"]+)"', block)
            if not (q and link):
                continue
            sizes = re.findall(r'<p class="quality-size">(.*?)</p>', block, re.S)
            strip = lambda s: html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s))).strip()
            release = strip(sizes[0]) if len(sizes) >= 1 else ""
            file_size = strip(sizes[1]) if len(sizes) >= 2 else ""
            t = {
                "quality": q.group(1).strip(),
                "release": release,
                "size": file_size,
                "download": link.group(1),
                "magnet": html.unescape(mag.group(1)) if mag else "",
            }
            if t not in info["torrents"]:
                info["torrents"].append(t)

        mg = re.search(r'data-torrent-id="\d+" href="(magnet:\?[^"]+)"', html_text)
        if mg:
            info["magnet"] = html.unescape(mg.group(1))
        return info

                                                                               
    def download_torrent(self, movie_url, torrent, dest_dir=DOWNLOAD_DIR, quiet=False):
        download_url = torrent["download"]
        if not download_url.startswith("http"):
            download_url = BASE + download_url
        body, headers, _ = self.get(download_url, referer=movie_url)

                                                                            
                                                
        filename = ""
        cd = headers.get("Content-Disposition", "")
        m = re.search(r'filename\*?="?([^";]+)"?', cd)
        if m and m.group(1):
            filename = urllib.parse.unquote(m.group(1).strip())
        if not filename:
            title = re.sub(r"[^\w\d() .\[\]-]+", "", torrent.get("q_title", ""))
            filename = "%s [%s] [%s].torrent" % (
                title or "movie",
                torrent["quality"],
                torrent.get("release") or "WEB",
            )
        safe = re.sub(r"[\\/:*?\"<>|]+", "_", filename)
        os.makedirs(dest_dir, exist_ok=True)
        path = os.path.join(dest_dir, safe)
        with open(path, "wb") as fh:
            fh.write(body)
        if not quiet:
            print("Saved: %s (%.1f KB)" % (path, len(body) / 1024.0))
        return path


                                                                             
GREEN = "\033[92m"
CYAN = "\033[96m"
YELLOW = "\033[93m"
RED = "\033[91m"
DIM = "\033[90m"
BOLD = "\033[1m"
END = "\033[0m"


def install_hint():
    return ("No torrent engine found. Install one:\n"
            "  * pip install libtorrent      (recommended, embedded)\n"
            "  * sudo apt install python3-libtorrent\n"
            "  * sudo apt install aria2      (uses aria2c)\n"
            "  * run qBittorrent with Web UI  (QB_URL/QBIT_USER/QBIT_PASS)")


def use_color():
    return sys.stdout.isatty()


def c(code, text):
    return code + text + END if use_color() else text


def fetch_ratings(client, listing):
    if listing["movies"] and not listing["movies"][0]["rating"]:
        return                                                           


def print_listing(listing, resolution=None):
    print()
    print(c(BOLD + GREEN, "=== %d movies [%s] (%s) ==="
            % (len(listing["movies"]), resolution or "all res", listing["url"])))
    for i, mv in enumerate(listing["movies"], 1):
        rating = "  " + c(YELLOW, mv["rating"] + "*") if mv["rating"] else ""
        print("  %2d. %s (%s)%s" % (i, c(CYAN, mv["title"]), mv["year"], rating))


def pick_quality(torrents):
    if not torrents:
        print(c(RED, "No download links found for this movie."))
        return None
    print()
    print(c(BOLD + GREEN, "Select torrent:"))
    for i, t in enumerate(torrents, 1):
        print("  %d) %-6s %-12s size: %s" % (i, t["quality"], t["release"], t["size"] or "?"))
    print("  m) print magnet link")
    print("  0) back")
    while True:
        choice = input(c(DIM, "quality> ")).strip().lower()
        if choice == "0":
            return None
        if choice == "m":
            for t in torrents:
                if t["magnet"]:
                    print(t["magnet"])
            continue
        if choice.isdigit() and 1 <= int(choice) <= len(torrents):
            return torrents[int(choice) - 1]
        print(c(RED, "Invalid choice."))


MENU = """
Commands:
  s <query>    search movies (uses current resolution filter)
  b [page]     browse list (default: current page)
  r            show resolutions; 'r 1080p' filters, 'r off' clears
  n / p        next / previous page
  <number>     open a movie, pick its resolution, then optionally
               download the actual VIDEO (engines: see v)
  d            download the first torrent of the last opened movie
  v            show video engine options / install hint
  q            quit
"""


def interactive(client, start_query=None, start_page=1, start_res=None, show_limit=20):
    listing = None
    page = start_page
    resolution = start_res                                                  
    last_movie_url = None

    def load(kw):
        if kw:
            print(c(GREEN, "Searching for '%s' [%s] ..." % (kw, resolution or "all res")))
            listing = client.search(kw, quality=resolution)
        else:
            print(c(GREEN, "Loading browse page %d [%s] ..." % (page, resolution or "all res")))
            listing = client.browse(page, quality=resolution)
        listing["movies"] = listing["movies"][:show_limit]
        return listing

    if start_query:
        listing = load(start_query)
    else:
        listing = load(None)
    print_listing(listing, resolution)
    print()
    print(c(DIM, MENU))

    while True:
        try:
            raw = input(c(GREEN + BOLD, "yts[%s]> " % (resolution or "all"))).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            continue

        try:
            if raw.lower() in ("q", "quit", "exit"):
                break
            elif raw.lower().startswith("r"):
                args = raw.split()
                if len(args) == 1:
                    print("Resolutions: %s | all" % ", ".join(RESOLUTIONS))
                    print(c(DIM, "Set one with e.g. 'r 1080p'. Currently: %s"
                            % (resolution or "all")))
                    continue
                val = args[1].lower().lstrip(".")
                if val in ("all", "off", "0", "none"):
                    resolution = None
                    print(c(GREEN, "Resolution filter cleared."))
                elif val in RESOLUTIONS:
                    resolution = val
                    page = 1
                    print(c(GREEN, "Resolution filter set to %s." % resolution))
                else:
                    print(c(RED, "Unknown resolution '%s'. Options: %s, all" % (val, ", ".join(RESOLUTIONS))))
                    continue
                listing = load(None)
                print_listing(listing, resolution)
                continue
            elif raw.lower() == "s":
                q = input(c(DIM, "search: ")).strip()
                if not q:
                    continue
                listing = load(q)
                print_listing(listing, resolution)
            elif raw.lower() == "b":
                args = raw.split()
                if len(args) > 1 and args[1].isdigit():
                    page = int(args[1])
                listing = load(None)
                print_listing(listing, resolution)
            elif raw.lower() == "n":
                page += 1
                listing = load(None)
                print_listing(listing, resolution)
            elif raw.lower() == "p":
                if page > 1:
                    page -= 1
                listing = load(None)
                print_listing(listing, resolution)
            elif raw.isdigit():
                idx = int(raw)
                if not listing or not (1 <= idx <= len(listing["movies"])):
                    print(c(RED, "No movie at that number (list has %s items)."
                            % (len(listing["movies"]) if listing else 0)))
                    continue
                mv = listing["movies"][idx - 1]
                print(c(GREEN, "Opening: %s (%s) ..." % (mv["title"], mv["year"])))
                detail = client.movie_detail(mv["url"])
                last_movie_url = mv["url"]
                print()
                print(c(BOLD + CYAN, "%s (%s)" % (detail.get("title", mv["title"]), detail.get("year", ""))))
                if detail.get("rating"):
                    print("Rating: %s/10   Genres: %s" % (detail["rating"], ", ".join(detail.get("genres", []))))
                if detail.get("summary"):
                    print(c(DIM, detail["summary"][:400] + ("..." if len(detail["summary"]) > 400 else "")))
                t = pick_quality(detail["torrents"])
                if t:
                    title_all = detail.get("title") or mv["title"]
                    year_all = detail.get("year") or mv["year"]
                    t["q_title"] = "%s (%s)" % (title_all, year_all)
                    print(c(GREEN, "Downloading torrent file via yts.gg/torrent/download ..."))
                    path = client.download_torrent(last_movie_url, t)
                    magnet = t.get("magnet") or ""
                    if magnet:
                        print(c(DIM, "Magnet (also saved): %s" % magnet))
                        with open(path + ".magnet", "w", encoding="utf-8") as fh:
                            fh.write(magnet)

                                                                                
                    print(c(GREEN, "Done. .torrent saved to: %s" % path))
                    video_destination = os.path.join(VIDEOS_DIR, os.path.basename(path)[:-8] or "movie")
                    engine_free = video_engine.list_engines()
                    print("Also download the actual VIDEO file? engine: %s"
                          % c(CYAN, video_engine.detect_best() if engine_free else "none"))
                    if engine_free:
                        print("  y) yes - start now")
                        print("  n) no - keep only the .torrent / magnet (default)")
                        print("  engine overrides: %s" % ", ".join(engine_free))
                    go = input(c(DIM, "download video? [n]: ")).strip().lower()
                    if go in ("y", "yes"):
                        chosen = video_engine.detect_best()
                        if chosen == "none":
                            print(c(RED, install_hint()))
                            continue
                    else:
                        continue
                    print(c(GREEN, "Fetching video with engine '%s' -> %s" % (chosen, video_destination)))
                    ok, vids = video_engine.download_video(
                        torrent_path=path, magnet=magnet,
                        dest_dir=video_destination, engine=chosen)
                    if ok:
                        print(c(GREEN + BOLD, "Video ready:"))
                        for v in vids:
                            print("  %s (%.1f MB)" % (v, os.path.getsize(v) / 1048576.0))
                    else:
                        print(c(RED, "Video download did not finish (see messages above)."))
            elif raw.lower() == "v":
                got = video_engine.list_engines()
                best = video_engine.detect_best()
                print("Video engines detected: %s | best: %s"
                      % (c(CYAN, ", ".join(got) or "none"), c(CYAN, best)))
                if not got:
                    print(c(RED, install_hint()))
            elif raw.lower() == "d":
                if not last_movie_url:
                    print(c(RED, "Open a movie first."))
                    continue
                detail = client.movie_detail(last_movie_url)
                if detail["torrents"]:
                    t = detail["torrents"][0]
                    t["q_title"] = detail.get("title", "")
                    client.download_torrent(last_movie_url, t)
            else:
                                                           
                listing = load(raw)
                print_listing(listing, resolution)
        except urllib.error.HTTPError as e:
            print(c(RED, "HTTP error %s for %s" % (e.code, e.url)))
        except urllib.error.URLError as e:
            print(c(RED, "Network error: %s" % e.reason))
        except RuntimeError as e:
            print(c(RED, str(e)))
        time.sleep(0.2)                             


def ask(prompt, default=""):
    raw = input(prompt).strip()
    return raw or default


def ask_resolution():
    print()
    print(c(BOLD + CYAN, "Resolution filter:"))
    print("  a) all resolutions (default)")
    for i, r in enumerate(RESOLUTIONS, 1):
        print("  %d) %s" % (i, r))
    while True:
        val = ask(c(DIM, "choice [a]: ")).lower()
        if val in ("", "a", "all", "0", "off", "none"):
            return None
        if val.isdigit() and 1 <= int(val) <= len(RESOLUTIONS):
            return RESOLUTIONS[int(val) - 1]
        if val.lower().lstrip(".") in RESOLUTIONS:
            return val.lower().lstrip(".")
        print(c(RED, "Invalid choice - type a number or 'a'."))


def main():
    print(c(GREEN + BOLD, "=== YTS.GG movie browser / torrent downloader ==="))
    engine = video_engine.detect_best()
    print("Video engine: %s" % (c(CYAN, engine) if engine != "none" else c(RED, "none")))
    others = [e for e in video_engine.list_engines() if e != engine]
    if engine != "none" and others:
        print(c(DIM, "  also installed: %s" % ", ".join(others)))
    if engine == "none":
        print(c(RED, "No engine -> video fetching disabled (only .torrent + magnet)."))
        print(c(DIM, install_hint()))

                                                                            
    while True:
        val = ask(c(DIM, "Enter start page (1-...): "), "1")
        if val.isdigit() and int(val) >= 1:
            page = int(val)
            break
        print(c(RED, "Whole numbers >= 1 only."))

                                                                            
    while True:
        val = ask(c(DIM, "How many movies to show on that page? [20]: "), "20")
        if val.isdigit() and int(val) >= 1:
            show_limit = int(val)
            break
        print(c(RED, "Whole numbers >= 1 only."))

                                                                              
    resolution = ask_resolution()

                                                                            
    start_query = None
    print()
    print("  b) browse the movie list (default)")
    print("  s) search by title")
    mode = ask(c(DIM, "choice [b]: ")).lower()
    if mode == "s":
        start_query = ask(c(DIM, "search: ")).strip()
        while not start_query:
            start_query = ask(c(RED, "Empty - search: ")).strip()

    client = YTSClient()
                                                        
    interactive(client, start_query=start_query, start_page=page,
                start_res=resolution, show_limit=show_limit)


if __name__ == "__main__":
    main()
