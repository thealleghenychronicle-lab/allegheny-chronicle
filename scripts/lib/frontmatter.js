/**
 * Minimal YAML-frontmatter parser for our known article schema.
 * Handles: strings (quoted or bare), booleans, numbers, dates, and
 * simple one-line arrays (`tags: ["a", "b"]` or block lists).
 * This keeps the whole build dependency-free.
 */
function parseScalar(raw) {
  let v = raw.trim();
  if (v === "") return "";
  if (/^["'].*["']$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseInlineArray(raw) {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((s) => parseScalar(s.trim()));
}

function parseFrontmatter(fileText) {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, content: fileText };

  const [, fmBlock, content] = match;
  const lines = fmBlock.split(/\r?\n/);
  const data = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let value = kv[2];

    if (value.trim() === "" ) {
      // Possible block list on following lines: "  - item"
      const listItems = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        listItems.push(parseScalar(lines[j].replace(/^\s*-\s+/, "")));
        j++;
      }
      if (listItems.length) {
        data[key] = listItems;
        i = j;
        continue;
      }
      data[key] = "";
      i++;
      continue;
    }

    if (/^\[.*\]$/.test(value.trim())) {
      data[key] = parseInlineArray(value);
    } else {
      data[key] = parseScalar(value);
    }
    i++;
  }

  return { data, content: content.replace(/^\r?\n/, "") };
}

module.exports = { parseFrontmatter };
