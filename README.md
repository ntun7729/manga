# Manga path fetcher

Node.js crawler for collecting manga detail URLs from a WordPress/Madara-style `/manga/` index.

Default target:

```text
https://dev-eternal-galaxy-doujinshipaid.pantheonsite.io/manga/
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

Results are written to:

- `output/manga-paths.txt` - one path per line, for example `/manga/25mayy/`
- `output/manga-urls.json` - full URLs plus discovery metadata

## Useful commands

```sh
# Use the default site
npm run crawl

# Crawl a different /manga/ index
node src/fetch-manga-paths.js --base "https://example.com/manga/"

# Crawl more archive pages
node src/fetch-manga-paths.js --max-pages 80

# Be gentler on shared hosting
node src/fetch-manga-paths.js --concurrency 2 --delay 750
```

## What it does

The script tries three discovery methods:

1. WordPress REST search, including the common `wp-manga` custom post type.
2. WordPress sitemap XML files.
3. HTML archive crawling from `/manga/`, `/manga/page/2/`, etc.

It only records URLs on the same host that look like manga detail pages under `/manga/<slug>/`.
