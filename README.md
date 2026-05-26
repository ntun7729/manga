# Manga final URL fetcher

Node.js crawler for collecting final nested manga/chapter URLs from a WordPress/Madara-style `/manga/` index.

Default target:

```text
https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/
```

It collects both manga pages like:

```text
https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/25mayy/
```

and final nested URLs like:

```text
https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/25mayy/2kyounn/
```

## Termux / proot usage

```sh
pkg update
pkg install git nodejs

git clone https://github.com/ntun7729/manga.git
cd manga
npm install
npm run crawl
```

If you already cloned the repo before:

```sh
cd manga
git pull
npm run crawl
```

## Output files

Results are written to:

- `output/final-full-urls.txt` - full final HTTPS URLs, for example `https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/25mayy/2kyounn/`
- `output/final-paths.txt` - final nested paths only, for example `/manga/25mayy/2kyounn/`
- `output/final-urls.json` - full final URLs plus metadata
- `output/manga-with-final-paths.json` - manga pages grouped with their final paths and full final URLs
- `output/manga-full-urls.txt` - full parent manga HTTPS URLs
- `output/manga-paths.txt` - parent manga paths only, for example `/manga/25mayy/`
- `output/manga-urls.json` - parent manga URLs plus metadata

## Useful commands

```sh
# Use the default site
npm run crawl

# Crawl a different /manga/ index
node src/fetch-manga-paths.js --base "https://example.com/manga/"

# Crawl more archive pages
node src/fetch-manga-paths.js --max-pages 100

# Be gentler on shared hosting
node src/fetch-manga-paths.js --concurrency 2 --delay 750
```

## What it does

The script tries four discovery steps:

1. WordPress REST search, including common manga custom post types.
2. WordPress sitemap XML files.
3. HTML archive crawling from `/manga/`, `/manga/page/2/`, etc.
4. Opening every discovered manga page and collecting nested links matching `/manga/<manga-slug>/<final-slug>/`.

It only records URLs on the same host.
