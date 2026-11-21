import { pageUrl } from './sources.js';

const dimensions = ['场地回应', '形式操作', '空间氛围', '材料逻辑', '运营策略'];
const imageLabels = ['EXTERIOR', 'INTERIOR', 'PLAN'];
const required = (obj, keys) => keys.every((k) => typeof obj?.[k] === 'string' && obj[k].trim());
const sized = (v, n) => Array.isArray(v) && v.length === n;

export function readReport(text, evidence) {
  const match = text.match(/<deck-data>([\s\S]*?)<\/deck-data>/);
  if (!match) throw new Error('Missing deck-data block');
  let d;
  try {
    d = JSON.parse(match[1]);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (
    !required(d?.project, ['titleCn', 'abstract', 'location', 'area', 'type']) ||
    !Array.isArray(d.project.requirements) ||
    !d.project.requirements.length ||
    !d.project.requirements.every((r) => typeof r === 'string' && r.trim()) ||
    !sized(d.cases, 4) ||
    !required(d.comparison, ['intro']) ||
    !sized(d.takeaways, 5)
  )
    throw new Error('Expected project metadata, requirements, 4 cases, comparison and 5 takeaways');

  const sources = new Set();
  for (const [i, c] of d.cases.entries()) {
    if (
      !required(c, ['titleCn', 'titleEn', 'architect', 'typology', 'location', 'area', 'relevance']) ||
      !['string', 'number'].includes(typeof c.year) ||
      !sized(c.images, 3)
    )
      throw new Error('Incomplete case metadata or image slots');
    const source = pageUrl(c.sourceUrl);
    const page = evidence.pages.get(source);
    const canonical = page?.url || source;
    if (!source || (!page && !evidence.search.has(source)) || sources.has(canonical))
      throw new Error(
        'Each case needs a distinct source URL seen in search results or in a fetched page',
      );
    sources.add(canonical);
    c.sourceUrl = canonical;
    c.sourceRead = Boolean(page);
    c.code = String(i + 1).padStart(2, '0');
    c.anchor = i === 3;
    c.images.forEach((img, j) => {
      if (!required(img, ['analysisLabel', 'analysisBody']) || img.label !== imageLabels[j])
        throw new Error('Expected EXTERIOR, INTERIOR and PLAN analysis in order');
      img.url = page?.images.has(img.url) ? img.url : '';
      img.fit = j === 2 ? 'contain' : '';
    });
  }
  d.takeaways.forEach((t, i) => {
    if (!required(t, ['labelEn', 'lesson', 'direction']) || t.labelCn !== dimensions[i])
      throw new Error('Incomplete or unordered takeaways');
    t.code = String(i + 1).padStart(2, '0');
  });
  return d;
}

export function renderReport(template, data) {
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  // Empty the sample sections before loading real data and avoid requests for sample thumbnails.
  const shell = template.replace(
    /(<section class="page[^"]*" data-idx="\d+">)[\s\S]*?<\/section>/g,
    '$1</section>',
  );
  return shell.replace(
    '</head>',
    () => '<script type="application/json" id="research-data">' + json + '</script>\n</head>',
  );
}
