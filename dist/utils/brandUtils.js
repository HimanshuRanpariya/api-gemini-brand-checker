const levenshtein = (a, b) => {
  if (!a) return b.length;
  if (!b) return a.length;
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => new Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + substitutionCost
      );
    }
  }
  return matrix[b.length][a.length];
};

function extractTextFromApiResponse(resp) {
  try {
    if (!resp) return '';
    const data = resp.data || resp;
    if (typeof data === 'string') return data;
    if (data.output_text) return data.output_text;
    if (data.output && Array.isArray(data.output) && data.output.length) {
      const o = data.output[0];
      if (typeof o === 'string') return o;
      if (o.content) {
        if (typeof o.content === 'string') return o.content;
        if (Array.isArray(o.content)) return o.content.map(c => (c.text || c)).join('\n');
      }
    }
    if (data.choices && data.choices.length) {
      const ch = data.choices[0];
      if (ch.text) return ch.text;
      if (ch.message && ch.message.content) return ch.message.content;
    }
    return JSON.stringify(data);
  } catch (e) {
    return '';
  }
}

function splitIntoItems(text) {
  if (!text) return [];
  let lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    lines = text.split(/,|;|\n/).map(l => l.trim()).filter(Boolean);
  }
  return lines;
}

function findBrandPositions(items, brand) {
  const brandLower = brand.toLowerCase();
  const positions = [];
  let currentRank = 0; // track numeric list rank when present
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemLower = item.toLowerCase();
    // Escape the brand for use in a regex (handle special regex chars)
    const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapeForRegex(brand)}\\b`, 'i');
    // Detect numbered list prefix at the start of the item, e.g. "1." or "2)"
    const numMatch = item.match(/^\s*(\d+)[\.)]\s*/);
    if (numMatch) {
      currentRank = parseInt(numMatch[1], 10);
    }

    if (regex.test(item)) {
      // If we are inside a numbered list, report that numeric rank instead of the line index
      if (currentRank && currentRank > 0) positions.push(currentRank);
      else positions.push(i + 1);
      continue;
    }
    if (itemLower.includes(brandLower)) {
      if (currentRank && currentRank > 0) positions.push(currentRank);
      else positions.push(i + 1);
      continue;
    }
    // Tokenize and normalize tokens: remove non-alphanumeric characters
    const tokens = item.split(/\s+/).map(t => t.replace(/[^a-z0-9]/gi, ''));
    const brandClean = brandLower.replace(/[^a-z0-9]/gi, '');
    for (const t of tokens) {
      if (!t) continue;
      const tokenLower = t.toLowerCase();
      const dist = levenshtein(tokenLower, brandClean.toLowerCase());
      // Use a dynamic threshold: allow small edits for short tokens, larger for longer
      const threshold = Math.max(1, Math.floor(brandClean.length * 0.25));
      if (dist <= Math.max(2, threshold)) {
        positions.push(i + 1);
        break;
      }
    }
  }
  return positions;
}

module.exports = {
  levenshtein,
  extractTextFromApiResponse,
  splitIntoItems,
  findBrandPositions
};
