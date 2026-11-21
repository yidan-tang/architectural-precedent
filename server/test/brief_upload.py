from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

from playwright.sync_api import expect


def word_file(title):
    stream = BytesIO()
    with ZipFile(stream, 'w', ZIP_DEFLATED) as doc:
        doc.writestr('word/document.xml', f'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>{escape(title)}</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>建筑面积</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>1500 平方米</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>''')
    return stream.getvalue()


def check_uploads(page, host):
    picker = page.get_by_label('上传任务书')
    field = page.locator('#brief')
    status = page.locator('#file-status')
    generate = page.locator('#submit-btn')

    def select(name, data):
        picker.set_input_files({'name': name, 'mimeType': 'application/octet-stream', 'buffer': data})
        expect(picker).to_be_enabled()

    requests = []
    page.on('request', lambda req: requests.append(req) if req.method == 'POST' else None)
    select('乡村文化站.DOCX', word_file('乡村文化站'))
    expect(field).to_have_value('乡村文化站\n建筑面积\t1500 平方米')
    select('broken.docx', b'broken')
    expect(status).to_contain_text('无法读取')
    expect(field).to_have_value('乡村文化站\n建筑面积\t1500 平方米')
    select('old.doc', b'old')
    expect(status).to_contain_text('另存为')
    select('large.txt', b'A' * (10 * 1024 * 1024 + 1))
    expect(status).to_contain_text('超过 10 MB')
    select('empty.txt', b'')
    expect(status).to_contain_text('文件为空')
    select('长任务书.md', ('甲' * 16001).encode())
    expect(field).to_have_value('甲' * 16001)
    expect(generate).to_be_disabled()
    field.fill('精简版')
    expect(generate).to_be_enabled()

    sample = page.context.new_page()
    try:
        sample.set_content('<p>Library design brief</p><p style="break-before:page">Room area 1500 sqm</p>')
        select('设计任务书.pdf', sample.pdf())
        pdf_text = field.input_value()
        assert 'Library design brief' in pdf_text and 'Room area 1500 sqm' in pdf_text, pdf_text
        sample.set_content('<svg width="80" height="30"><rect width="80" height="30"/></svg>')
        select('扫描版.pdf', sample.pdf())
        expect(status).to_contain_text('OCR')
        expect(field).to_have_value(pdf_text)
    finally:
        sample.close()

    select('任务书.txt', '中文任务要求'.encode('gb18030'))
    expect(field).to_have_value('中文任务要求')
    select('任务书.md', ('# 草案\r\n' + host['brief']).encode('utf-8-sig'))
    expect(field).to_have_value('# 草案\n' + host['brief'])
    assert not requests, 'Selecting a file must not upload the document or trigger generation'
    field.fill(host['brief'])
    with page.expect_request(lambda req: req.method == 'POST' and req.url.endswith('/api/generate')) as submit:
        generate.click()
    assert submit.value.post_data_json == {'brief': host['brief']}
