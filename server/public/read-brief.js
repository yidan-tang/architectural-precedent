// Files are parsed on this device. Only the edited textarea is submitted.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 300_000;
const previewLimit = '正文过长，请只上传任务书中与本次设计相关的章节。';

class BriefLimitError extends Error {}

function plainText(bytes) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
  }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('Invalid text file');
  return text;
}

async function wordText(bytes) {
  const { unzipSync } = await import('/vendor/fflate.js');
  const name = 'word/document.xml';
  const files = unzipSync(bytes, {
    filter(entry) {
      if (entry.name !== name) return false;
      if (entry.originalSize > 8 * 1024 * 1024) throw new BriefLimitError(previewLimit);
      return true;
    },
  });
  if (!files[name]) throw new Error('Missing Word document');
  const xml = new DOMParser().parseFromString(plainText(files[name]), 'application/xml');
  const ns = xml.documentElement.namespaceURI;
  if (xml.documentElement.localName !== 'document') throw new Error('Invalid Word document');
  const parts = [];
  let previousCell;
  let previousRow;
  const paragraphs = xml.getElementsByTagNameNS(ns, 'p');
  for (const paragraph of paragraphs) {
    const cell = paragraph.closest('tc');
    const row = cell?.closest('tr');
    if (parts.length) parts.push(row && row === previousRow && cell !== previousCell ? '\t' : '\n');
    for (const item of paragraph.getElementsByTagNameNS(ns, '*')) {
      if (item.closest('p') !== paragraph) continue;
      if (item.localName === 't') parts.push(item.textContent);
      else if (item.localName === 'tab') parts.push('\t');
      else if (item.localName === 'br' || item.localName === 'cr') parts.push('\n');
    }
    previousRow = row;
    previousCell = cell;
  }
  return parts.join('');
}

async function pdfText(bytes) {
  const pdfjs = await import('/vendor/pdf/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf/pdf.worker.min.mjs';
  const task = pdfjs.getDocument({
    data: bytes,
    cMapUrl: '/vendor/pdf/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdf/standard_fonts/',
    useWorkerFetch: true,
    useWasm: false,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 200)
      throw new BriefLimitError('PDF 超过 200 页，请选取与本次设计相关的页面后重试。');
    const pages = [];
    let total = 0;
    let emptyPages = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let lineText = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        if (/[A-Za-z0-9]$/.test(lineText) && /^[A-Za-z0-9]/.test(item.str)) lineText += ' ';
        lineText += item.str + (item.hasEOL ? '\n' : '');
      }
      page.cleanup();
      const text = lineText.trim();
      if (!text) emptyPages++;
      total += text.length;
      if (total > MAX_PREVIEW_CHARS) throw new BriefLimitError(previewLimit);
      pages.push(text);
    }
    return {
      text: pages.join('\n\n'),
      warning: emptyPages ? '部分页面未提取到文字，请核对扫描页或图纸中的要求。' : '',
    };
  } finally {
    await task.destroy();
  }
}

export async function readBrief(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'txt', 'md'].includes(ext))
    throw new Error('请选择 DOCX、文字版 PDF、TXT 或 MD 文件。旧版 Word 请先另存为 .docx。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 10 MB，请缩小文件或选取所需章节。');
  if (!file.size) throw new Error('文件为空，请重新选择。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let result;
  try {
    result =
      ext === 'pdf'
        ? await pdfText(bytes)
        : {
            text: ext === 'docx' ? await wordText(bytes) : plainText(bytes),
            warning: '',
          };
  } catch (error) {
    if (error instanceof BriefLimitError) throw error;
    if (error.name === 'PasswordException')
      throw new Error('PDF 有密码，请先在本机解除密码后再选择文件。');
    throw new Error('无法读取文件，请检查文件格式，或复制正文到下方。');
  }
  result.text = result.text.replace(/\r\n?/g, '\n').trim();
  if (!result.text)
    throw new Error(
      ext === 'pdf'
        ? 'PDF 未提取到文字。扫描版请先做 OCR 文字识别，或直接粘贴正文。'
        : '未找到正文，请检查文件或直接粘贴文字。',
    );
  if (result.text.length > MAX_PREVIEW_CHARS) throw new Error(previewLimit);
  return result;
}
