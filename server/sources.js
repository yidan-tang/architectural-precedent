const PUBLISHERS = ['archdaily.com', 'archdaily.cn', 'dezeen.com', 'gooood.cn'];
const PAGE_HOSTS = new Set(PUBLISHERS.flatMap((host) => [host, 'www.' + host]));
const IMAGE_HOSTS = new Set([...PAGE_HOSTS, 'images.adsttc.com', 'static.dezeen.com', 'oss.gooood.cn']);

function approvedUrl(raw, hosts, base) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const url = new URL(raw, base);
    if (
      url.protocol !== 'https:' ||
      !hosts.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export const pageUrl = (raw, base) => approvedUrl(raw, PAGE_HOSTS, base);
const decode = (value) => value.replace(/&amp;|&#38;|&#x26;/gi, '&').replace(/&quot;/gi, '"');

export function extractPage(html, url) {
  const plain = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const title = plain.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
  const images = new Map();
  const descriptions = new Set();
  for (const [tag] of plain.matchAll(/<(?:meta|img|source)\b[^>]{0,16000}>/gi)) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/g)) {
      attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4]);
    }
    const isMeta = /^<meta\b/i.test(tag);
    if (
      isMeta &&
      ['description', 'og:description'].includes(attrs.property || attrs.name) &&
      attrs.content
    )
      descriptions.add(attrs.content);
    if (isMeta && !['og:image', 'og:image:url', 'twitter:image'].includes(attrs.property || attrs.name))
      continue;
    const candidates = isMeta
      ? [attrs.content]
      : [
          attrs['data-src'],
          attrs['data-original'],
          attrs['data-image'],
          ...(attrs['data-srcset'] || attrs.srcset || '')
            .split(',')
            .reverse()
            .map((x) => x.trim().split(/\s+/)[0]),
          attrs.src,
        ];
    for (const item of candidates) {
      const src = approvedUrl(item, IMAGE_HOSTS, url);
      if (src && !/\b(?:avatar|logo|icon)\b/i.test(new URL(src).pathname)) {
        images.set(src, (attrs.alt || attrs.title || '').slice(0, 160));
        break;
      }
    }
    if (images.size >= 48) break;
  }
  // Some ArchDaily galleries expose the CDN URL in page data instead of img tags.
  for (const [raw] of html.matchAll(
    /https:\/\/images\.adsttc\.com\/[^"'\s<>\\]+\.(?:jpe?g|png|webp)(?:\?[^"'\s<>\\]*)?/gi,
  )) {
    if (images.size >= 48) break;
    const src = approvedUrl(decode(raw), IMAGE_HOSTS);
    if (src && !images.has(src)) images.set(src, '');
  }
  const article = plain.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || plain;
  const body = decode(article.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
  return {
    url,
    title: decode(title).trim(),
    text: [...descriptions, body].join('\n').slice(0, 6000),
    images,
  };
}

export async function fetchPage(raw, jobSignal, get = fetch) {
  let url = pageUrl(raw);
  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(12000)]);
  for (let hop = 0; url && hop < 4; hop++) {
    const res = await get(url, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'ArchitecturalPrecedentAgent/0.2',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      url = pageUrl(res.headers.get('location'), url);
      await res.body?.cancel();
      continue;
    }
    if (
      !res.ok ||
      !/^(text\/html|application\/xhtml\+xml)\b/i.test(res.headers.get('content-type') || '')
    ) {
      await res.body?.cancel();
      throw new Error('项目页面暂不可读取');
    }
    let bytes = 0;
    const parts = [];
    for await (const part of res.body) {
      bytes += part.length;
      if (bytes > 3 * 1024 * 1024) throw new Error('项目页面过大');
      parts.push(part);
    }
    return extractPage(Buffer.concat(parts).toString('utf8'), url);
  }
  throw new Error('来源不在支持范围，或页面跳转过多');
}
