/**
 * The Allegheny Chronicle — build script
 * Reads markdown articles from /content/articles, compiles them into:
 *   - /public/articles.json        (data + search index used by the homepage & search page)
 *   - /public/articles/<slug>/index.html  (a real, SEO-complete page per article)
 *   - /public/sitemap.xml
 * Runs automatically on every Netlify deploy via `npm run build`.
 */
const fs = require("fs");
const path = require("path");
const { parseFrontmatter } = require("./lib/frontmatter");
const { renderMarkdown, extractHeadingsFromHtml } = require("./lib/markdown");

const ROOT = path.join(__dirname, "..");
const CONTENT_DIR = path.join(ROOT, "content", "articles");
const PUBLIC_DIR = path.join(ROOT, "public");
const ARTICLES_OUT_DIR = path.join(PUBLIC_DIR, "articles");
const SITE_URL = (process.env.URL || process.env.DEPLOY_PRIME_URL || "https://theallegheny-chronicle.netlify.app").replace(/\/$/, "");

function readingTimeMinutes(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readArticles() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  const files = fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith(".md"));
  const articles = files
    .map((file) => {
      const raw = fs.readFileSync(path.join(CONTENT_DIR, file), "utf8");
      const { data, content } = parseFrontmatter(raw);
      if (data.draft) return null;

      // SEO-friendly, keyword-rich slug: prefer an explicit slug, otherwise
      // build one from the business name + title + location so every
      // article URL is unique and describes the business it covers.
      let slug;
      if (data.slug) {
        slug = slugify(data.slug);
      } else {
        const titleLower = (data.title || "").toLowerCase();
        const bizLower = (data.businessName || "").toLowerCase();
        const parts = [
          bizLower && !titleLower.includes(bizLower) ? data.businessName : null,
          data.title,
          data.location,
        ].filter(Boolean);
        slug = slugify(parts.join(" "))
          .split("-")
          .slice(0, 12) // keep URLs readable while staying keyword-rich
          .join("-");
      }
      if (!slug) slug = slugify(path.basename(file, ".md"));
      const bodyHtml = renderMarkdown(content);
      const plainText = stripMarkdown(content);
      const minutes = readingTimeMinutes(content);
      const headings = extractHeadingsFromHtml(bodyHtml);

      return {
        slug,
        title: data.title || "Untitled Story",
        author: data.author || "The Allegheny Chronicle Staff",
        date: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
        category: data.category || "Business",
        tags: Array.isArray(data.tags) ? data.tags : [],
        businessName: data.businessName || "",
        location: data.location || "",
        image: data.image || "/images/placeholder-hero.jpg",
        imageAlt: data.imageAlt || data.title || "",
        excerpt: data.excerpt || plainText.slice(0, 160) + "…",
        featured: !!data.featured,
        trending: !!data.trending,
        editorsPick: !!data.editorsPick,
        readingTime: minutes,
        bodyHtml,
        headings,
        searchText: [
          data.title,
          data.category,
          (data.tags || []).join(" "),
          data.businessName,
          data.location,
          data.excerpt,
          plainText,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const seen = new Map();
  articles.forEach((a) => {
    const count = seen.get(a.slug) || 0;
    if (count > 0) a.slug = `${a.slug}-${count + 1}`;
    seen.set(a.slug, count + 1);
  });

  return articles;
}

function renderMeta({ title, description, url, image }) {
  return `
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${image}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${image}" />`;
}

function articleTemplate() {
  return fs.readFileSync(path.join(__dirname, "templates", "article-template.html"), "utf8");
}

function buildArticlePages(articles) {
  ensureDir(ARTICLES_OUT_DIR);
  const tpl = articleTemplate();
  const escQ = (s) => JSON.stringify(s || "");

  articles.forEach((article) => {
    const outDir = path.join(ARTICLES_OUT_DIR, article.slug);
    ensureDir(outDir);
    const url = `${SITE_URL}/articles/${article.slug}/`;
    const dateFormatted = new Date(article.date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const related = articles
      .filter((a) => a.slug !== article.slug && a.category === article.category)
      .slice(0, 3);
    const relatedFallback = articles.filter((a) => a.slug !== article.slug).slice(0, 3);
    const relatedList = (related.length ? related : relatedFallback).slice(0, 3);

    const toc = article.headings.length
      ? `<nav class="toc" aria-label="Table of contents">
          <p class="toc__label">In this story</p>
          <ol>${article.headings
            .map((h) => `<li class="toc__item toc__item--${h.level}"><a href="#${h.id}">${h.text}</a></li>`)
            .join("")}</ol>
        </nav>`
      : "";

    const relatedHtml = relatedList.length
      ? relatedList
          .map(
            (r) => `
        <a class="related-card" href="/articles/${r.slug}/">
          <div class="related-card__img" style="background-image:url('${r.image}')"></div>
          <p class="related-card__cat">${r.category}</p>
          <h3 class="related-card__title">${r.title}</h3>
        </a>`
          )
          .join("")
      : `
        <div class="related-empty">
          <svg class="river-line" viewBox="0 0 84 14" aria-hidden="true"><path d="M0 7 C 20 2, 30 12, 42 7 S 64 2, 84 7"/></svg>
          <p class="related-empty__eyebrow">More Allegheny County Stories</p>
          <h3 class="related-empty__title">This is the first chapter.</h3>
          <p class="related-empty__body">
            ${article.title} is one of the first stories in The Allegheny Chronicle's coverage
            of ${article.category.toLowerCase()} across the Pittsburgh region.
            More reporting from ${article.location || "the region"} is on the way &mdash; check back soon,
            or head to the homepage to see what's been published since.
          </p>
          <a class="btn btn--gold" href="/">Back to the Chronicle</a>
        </div>`;
    const relatedClass = relatedList.length ? "related-section" : "related-section related-section--empty";

    const schema = {
      "@context": "https://schema.org",
      "@type": "NewsArticle",
      headline: article.title,
      image: [article.image],
      datePublished: article.date,
      author: [{ "@type": "Person", name: article.author }],
      publisher: {
        "@type": "Organization",
        name: "The Allegheny Chronicle",
        logo: { "@type": "ImageObject", url: `${SITE_URL}/images/logo.png` },
      },
      description: article.excerpt,
      mainEntityOfPage: { "@type": "WebPage", "@id": url },
    };

    const breadcrumbSchema = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
        { "@type": "ListItem", position: 2, name: article.category, item: `${SITE_URL}/search.html?q=${encodeURIComponent(article.category)}` },
        { "@type": "ListItem", position: 3, name: article.title, item: url },
      ],
    };

    let html = tpl
      .replace("{{META}}", renderMeta({ title: `${article.title} | The Allegheny Chronicle`, description: article.excerpt, url, image: article.image }))
      .replace("{{SCHEMA}}", `<script type="application/ld+json">${JSON.stringify(schema)}</script><script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>`)
      .replace(/{{TITLE}}/g, article.title)
      .replace(/{{CATEGORY}}/g, article.category)
      .replace(/{{AUTHOR}}/g, article.author)
      .replace(/{{DATE}}/g, dateFormatted)
      .replace(/{{DATE_ISO}}/g, article.date)
      .replace(/{{READING_TIME}}/g, article.readingTime)
      .replace(/{{IMAGE}}/g, article.image)
      .replace(/{{IMAGE_ALT}}/g, article.imageAlt)
      .replace("{{TOC}}", toc)
      .replace("{{BODY}}", article.bodyHtml)
      .replace("{{RELATED}}", relatedHtml)
      .replace("{{RELATED_CLASS}}", relatedClass)
      .replace(/{{URL}}/g, url)
      .replace("{{SHARE_JSON}}", escQ(article.title));

    fs.writeFileSync(path.join(outDir, "index.html"), html);
  });
}

function buildSitemap(articles) {
  const staticUrls = ["/", "/search.html", "/services"];
  const urls = [
    ...staticUrls.map((u) => `${SITE_URL}${u}`),
    ...articles.map((a) => `${SITE_URL}/articles/${a.slug}/`),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>`;
  fs.writeFileSync(path.join(PUBLIC_DIR, "sitemap.xml"), xml);
}

function buildRobots() {
  const content = `User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;
  fs.writeFileSync(path.join(PUBLIC_DIR, "robots.txt"), content);
}

function main() {
  const articles = readArticles();

  // Slim JSON for homepage + search (bodyHtml stripped to keep payload small; excerpt is enough there)
  const slim = articles.map(({ bodyHtml, headings, ...rest }) => rest);
  ensureDir(PUBLIC_DIR);
  fs.writeFileSync(path.join(PUBLIC_DIR, "articles.json"), JSON.stringify(slim, null, 2));

  buildArticlePages(articles);
  buildSitemap(articles);
  buildRobots();

  console.log(`Build complete. ${articles.length} article(s) compiled.`);
}

main();
