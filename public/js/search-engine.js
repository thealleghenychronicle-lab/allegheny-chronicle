// Lightweight fuzzy + partial matching search, tuned for business/trade terms
// (roof / roofing / roofer / roofers all match one another).
window.ChronicleSearch = (function () {
  var SUFFIXES = ["ers", "ing", "er", "es", "s"];

  function stem(word) {
    word = word.toLowerCase();
    for (var i = 0; i < SUFFIXES.length; i++) {
      var suf = SUFFIXES[i];
      if (word.length > suf.length + 2 && word.endsWith(suf)) {
        return word.slice(0, -suf.length);
      }
    }
    return word;
  }

  function tokenize(text) {
    return (text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  // Cheap edit-distance check, capped, for short typo tolerance.
  function levenshteinWithin(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return false;
    var dp = [];
    for (var i = 0; i <= a.length; i++) dp.push([i]);
    for (var j = 0; j <= b.length; j++) dp[0][j] = j;
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length] <= maxDist;
  }

  function fieldScore(fieldText, queryTokens, weight) {
    if (!fieldText) return 0;
    var lower = fieldText.toLowerCase();
    var fieldTokens = tokenize(fieldText);
    var score = 0;
    queryTokens.forEach(function (qt) {
      if (!qt) return;
      var qStem = stem(qt);
      if (lower.indexOf(qt) !== -1) {
        score += 3 * weight;
        return;
      }
      var stemHit = fieldTokens.some(function (ft) {
        return stem(ft).indexOf(qStem) === 0 || qStem.indexOf(stem(ft)) === 0;
      });
      if (stemHit) {
        score += 2 * weight;
        return;
      }
      if (qt.length >= 4) {
        var fuzzyHit = fieldTokens.some(function (ft) {
          return ft.length >= 4 && levenshteinWithin(ft, qt, 1);
        });
        if (fuzzyHit) score += 1 * weight;
      }
    });
    return score;
  }

  function search(articles, query) {
    var queryTokens = tokenize(query);
    if (!queryTokens.length) return [];

    var results = articles.map(function (article) {
      var score = 0;
      score += fieldScore(article.title, queryTokens, 4);
      score += fieldScore(article.category, queryTokens, 3);
      score += fieldScore((article.tags || []).join(" "), queryTokens, 3);
      score += fieldScore(article.businessName, queryTokens, 3);
      score += fieldScore(article.location, queryTokens, 2.5);
      score += fieldScore(article.excerpt, queryTokens, 1.5);
      score += fieldScore(article.searchText, queryTokens, 1);
      return { article: article, score: score };
    });

    return results
      .filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (r) { return r.article; });
  }

  return { search: search, stem: stem, tokenize: tokenize };
})();
