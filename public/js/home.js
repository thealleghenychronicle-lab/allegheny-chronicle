// Renders the homepage from /articles.json according to The Allegheny
// Chronicle's homepage logic: the layout adapts to how many published
// articles exist (0, 1, 2, 3, or 4+), and never shows placeholder content.
(function () {
  var main = document.getElementById("homeMain");

  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  }

  function svgArrow() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  }

  function riverLine() {
    return '<svg class="river-line" viewBox="0 0 84 14" aria-hidden="true"><path d="M0 7 C 20 2, 30 12, 42 7 S 64 2, 84 7"/></svg>';
  }

  function card(article, opts) {
    opts = opts || {};
    var sizeClass = opts.large ? " article-card--large" : "";
    return (
      '<a class="article-card' + sizeClass + ' fade-up" href="/articles/' + article.slug + '/">' +
        '<div class="article-card__img" style="background-image:url(\'' + article.image + '\')"></div>' +
        '<div class="article-card__body">' +
          '<span class="article-card__cat">' + article.category + '</span>' +
          '<h3 class="article-card__title">' + article.title + '</h3>' +
          '<p class="article-card__excerpt">' + article.excerpt + '</p>' +
          '<span class="article-card__meta">' + fmtDate(article.date) + ' &middot; ' + article.readingTime + ' min read</span>' +
          '<span class="read-more">Read More ' + svgArrow() + '</span>' +
        '</div>' +
      '</a>'
    );
  }

  function heroCard(article) {
    return (
      '<div class="hero-feature__card fade-up">' +
        '<div class="hero-feature__img" style="background-image:url(\'' + article.image + '\')"></div>' +
        '<div class="hero-feature__scrim"></div>' +
        '<div class="hero-feature__content">' +
          '<div class="hero-feature__meta">' +
            '<span class="tag">' + article.category + '</span>' +
            '<span class="dot">&middot;</span><span>' + fmtDate(article.date) + '</span>' +
            '<span class="dot">&middot;</span><span>' + article.readingTime + ' min read</span>' +
          '</div>' +
          '<h2>' + article.title + '</h2>' +
          '<p class="dek">' + article.excerpt + '</p>' +
          '<a class="btn btn--gold" href="/articles/' + article.slug + '/">Read More ' + svgArrow() + '</a>' +
        '</div>' +
      '</div>'
    );
  }

  function section(title, articles, opts) {
    opts = opts || {};
    var cols = opts.cols || 3;
    return (
      '<section class="section container">' +
        '<div class="section__head"><h2>' + riverLine() + title + '</h2></div>' +
        '<div class="card-grid card-grid--' + cols + '">' +
          articles.map(function (a) { return card(a, opts); }).join("") +
        '</div>' +
      '</section>'
    );
  }

  function emptyState() {
    return (
      '<div class="empty-state">' +
        '<div class="empty-state__inner">' +
          '<div class="empty-state__glow"></div>' +
          riverLine() +
          '<h1>Stories Worth Following Are Coming Soon.</h1>' +
          '<p>The Allegheny Chronicle is preparing to publish trusted business stories from across Allegheny County. Check back soon.</p>' +
        '</div>' +
      '</div>'
    );
  }

  function renderOne(articles) {
    var a = articles[0];
    main.innerHTML = '<div class="hero-feature container">' + heroCard(a) + '</div>' + section("Latest Story", [a], { cols: 3 });
  }

  function renderTwo(articles) {
    main.innerHTML =
      '<div class="section container">' +
        '<div class="section__head"><h2>' + riverLine() + 'Featured Stories</h2></div>' +
        '<div class="card-grid card-grid--2">' + articles.map(function (a) { return card(a, { large: true }); }).join("") + '</div>' +
      '</div>';
  }

  function renderThree(articles) {
    main.innerHTML =
      '<div class="hero-feature container">' + heroCard(articles[0]) + '</div>' +
      section("Also Featured", articles.slice(1), { cols: 2 });
  }

  function renderMany(articles) {
    var used = new Set();
    function take(list, n) {
      var out = [];
      for (var i = 0; i < list.length && out.length < n; i++) {
        if (!used.has(list[i].slug)) { out.push(list[i]); used.add(list[i].slug); }
      }
      return out;
    }

    var featuredPool = articles.filter(function (a) { return a.featured; });
    var featured = (featuredPool.length ? featuredPool : articles)[0];
    used.add(featured.slug);

    var trendingPool = articles.filter(function (a) { return a.trending && a.slug !== featured.slug; });
    var trending = trendingPool.length ? take(trendingPool, 4) : take(articles, 4);

    var picksPool = articles.filter(function (a) { return a.editorsPick; });
    var picks = picksPool.length ? take(picksPool, 3) : take(articles, 3);

    var latest = take(articles, 4);
    var recent = take(articles, 6);

    main.innerHTML =
      '<div class="hero-feature container">' + heroCard(featured) + '</div>' +
      (latest.length ? section("Latest Stories", latest, { cols: 4 }) : "") +
      (trending.length ? section("Trending Stories", trending, { cols: 4 }) : "") +
      (picks.length ? section("Editor's Picks", picks, { cols: 3 }) : "") +
      (recent.length ? section("Recently Published", recent, { cols: 3 }) : "");
  }

  fetch("/articles.json")
    .then(function (r) { return r.ok ? r.json() : []; })
    .catch(function () { return []; })
    .then(function (articles) {
      articles = articles || [];
      if (articles.length === 0) main.innerHTML = emptyState();
      else if (articles.length === 1) renderOne(articles);
      else if (articles.length === 2) renderTwo(articles);
      else if (articles.length === 3) renderThree(articles);
      else renderMany(articles);
    });
})();
