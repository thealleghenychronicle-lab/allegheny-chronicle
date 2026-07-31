# The Allegheny Chronicle — Deployment Guide

## What this is
A static, zero-dependency Netlify site. There's no framework and no npm
packages to install — the build script (`scripts/build.js`) is plain
Node.js, so there's nothing that can fail to install on Netlify's build
servers.

## Deploy it
1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. In Netlify: **Add new site → Import an existing project**, pick the repo.
3. Build settings are already set via `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `public`
4. Deploy. That's it — no environment variables required.

## Turning on the CMS (Decap CMS, free, built into `/admin`)
The site ships with a working content manager at `yoursite.com/admin`.
Netlify Identity + Git Gateway (the old way to do this) are both
**deprecated**, so this config uses **DecapBridge** instead — a free,
actively-maintained drop-in replacement built specifically for this.

1. Push this repo to GitHub (public or private both work).
2. Go to **decapbridge.com** and sign in with GitHub.
3. Click **Add site**, install the DecapBridge GitHub App on your repo
   (grants it read/write access to that one repo only), and register
   your Netlify site's URL.
4. DecapBridge will give you two values: a `repo` (in `owner/name`
   format) and an `identity_url` (something like
   `https://auth.decapbridge.com/sites/xxxxx`).
5. Open `public/admin/config.yml` in this project and replace the
   placeholders at the top:
   ```yaml
   backend:
     name: git-gateway
     repo: YOUR-GITHUB-USERNAME/YOUR-REPO-NAME
     branch: main
     identity_url: https://auth.decapbridge.com/sites/YOUR-SITE-ID
     gateway_url: https://gateway.decapbridge.com
   ```
6. Commit and push. Netlify auto-deploys the change.
7. Go to `yoursite.com/admin`, click **Login with GitHub**, authorize
   the DecapBridge app, and you're in. Every save runs the build
   automatically and updates the homepage, search index, and sitemap —
   no coding required.

Only people you (or DecapBridge) grant repo/app access to can log in —
so it's safe to hand this URL to a client without giving them a GitHub
account or repo access directly.

## How the homepage logic works
`content/articles/*.md` is the source of truth. On every build,
`scripts/build.js`:
- Skips anything marked `draft: true`
- Writes `public/articles.json` (used by the homepage and search page)
- Generates a real, unique static page per article at
  `/articles/<seo-slug>/index.html` — with its own title, meta
  description, canonical URL, Open Graph/Twitter tags, and
  NewsArticle + Breadcrumb schema
- Regenerates `sitemap.xml` and `robots.txt`

The homepage (`public/js/home.js`) reads that JSON at runtime and
switches layout automatically at 0 / 1 / 2 / 3 / 4+ published articles,
exactly per spec — no manual coding needed as you publish.

## Article URLs
Slugs are built from **business name + title + location** (whichever
of those are filled in), so every article URL is unique and
keyword-rich for the business it covers — e.g.:
`/articles/riverside-roofing-co-how-trust-was-rebuilt-squirrel-hill/`
You can also set a fully custom slug per article in the CMS if you'd
prefer to hand-write it.

## Related articles on each page
Every article page shows up to 3 related stories (same category first,
then falls back to the newest others) styled as clickable thumbnail
cards with the linked article's image — same idea as a "recommended
videos" rail. If there's nothing else published yet, that space
becomes a distinct on-brand panel (not blank, not a generic placeholder)
inviting the reader back to the homepage.

## A demo article is included, in draft
`content/articles/riverside-roofing.md` is a sample article with
`draft: true`, so it won't appear on the live site. It's there so you
(or a developer) can flip `draft: false` and immediately see the full
article-page treatment — hero, table of contents, share buttons,
related stories — before real content is loaded in.

## Search
`public/js/search-engine.js` is a small fuzzy/partial matcher (roof →
roofing/roofer/roofers, plumber → plumbing/pipe repair, etc.) that runs
client-side against `articles.json`. This comfortably handles hundreds
of articles. If the catalog grows into the thousands, consider
swapping it for a hosted index (Algolia, or the static-friendly
Pagefind) — the search page's rendering code can stay as-is; only the
matching call would change.

## Netlify Forms
The "Request a Free Quote" form in the sidebar uses Netlify Forms
(`data-netlify="true"`), so submissions land in your Netlify dashboard
under **Forms** automatically — no backend needed. It only ever
appears in the sidebar, per spec.

## Images
Replace `public/images/placeholder-hero.jpg` usage by uploading a real
featured image per article in the CMS (Decap CMS stores uploads in
`public/images/articles/`). The AC logo is at
`public/images/logo.png` (white background) and
`public/images/logo-transparent.png` (transparent, used in the header).
