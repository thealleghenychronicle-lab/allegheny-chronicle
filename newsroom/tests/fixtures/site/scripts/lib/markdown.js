/**
 * Small, dependency-free Markdown renderer covering the subset article
 * bodies use: headings, paragraphs, bold/italic, links, images, blockquotes,
 * ordered/unordered lists, and code spans. Keeps the build free of npm deps.
 */
function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function inline(text) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function renderMarkdown(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let listBuffer = null; // { type: 'ul'|'ol', items: [] }

  function flushList() {
    if (!listBuffer) return;
    const tag = listBuffer.type;
    out.push(`<${tag}>` + listBuffer.items.map((it) => `<li>${inline(it)}</li>`).join("") + `</${tag}>`);
    listBuffer = null;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flushList(); i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = slugifyHeading(text);
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushList();
      const buf = [quote[1]];
      let j = i + 1;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        buf.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      i = j;
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (!listBuffer || listBuffer.type !== "ol") { flushList(); listBuffer = { type: "ol", items: [] }; }
      listBuffer.items.push(ol[1]);
      i++;
      continue;
    }

    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (!listBuffer || listBuffer.type !== "ul") { flushList(); listBuffer = { type: "ul", items: [] }; }
      listBuffer.items.push(ul[1]);
      i++;
      continue;
    }

    flushList();
    // Paragraph: gather contiguous non-empty, non-special lines
    const buf = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !/^(#{1,6})\s/.test(lines[j]) &&
      !/^>\s?/.test(lines[j]) &&
      !/^[-*]\s+/.test(lines[j]) &&
      !/^\d+\.\s+/.test(lines[j])
    ) {
      buf.push(lines[j]);
      j++;
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
    i = j;
  }
  flushList();
  return out.join("\n");
}

function extractHeadingsFromHtml(html) {
  const re = /<h([2-3])\s+id="([^"]+)">(.*?)<\/h[2-3]>/g;
  const headings = [];
  let m;
  while ((m = re.exec(html))) {
    headings.push({ level: Number(m[1]), id: m[2], text: m[3].replace(/<[^>]+>/g, "") });
  }
  return headings;
}

module.exports = { renderMarkdown, extractHeadingsFromHtml };
