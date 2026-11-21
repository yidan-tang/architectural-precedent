import base64, json, os, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
server = Path(__file__).resolve().parents[1]
launcher = """import {startTrial} from './test/trial-host.js';
const h=await startTrial(process.env.BROWSER_TEST_PROVIDER); console.log(JSON.stringify({url:h.url,password:h.password,brief:h.brief}));
process.on('SIGTERM',async()=>{await h.close();process.exit(0)});"""
app = subprocess.Popen(['node','--input-type=module','-e',launcher],cwd=server,stdout=subprocess.PIPE,text=True)
try:
    host=json.loads(app.stdout.readline())
    with sync_playwright() as p:
        options = {}
        if os.environ.get('BROWSER_TEST_EXECUTABLE'):
            options = {'executable_path': os.environ['BROWSER_TEST_EXECUTABLE']}
        if os.environ.get('BROWSER_TEST_SINGLE_PROCESS') == '1':
            options['args'] = ['--single-process','--disable-gpu']
        browser = p.chromium.launch(**options)
        context=browser.new_context(http_credentials={'username':'trial','password':host['password']},accept_downloads=True)
        def external(route):
            if route.request.url.startswith('https://images.adsttc.com/fixture/'):
                route.fulfill(content_type='image/png',body=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmO0AAAAASUVORK5CYII='))
            else:route.abort()
        context.route('https://**/*',external)
        pg=context.new_page(); errors=[];pg.on('pageerror',lambda e:errors.append(str(e)))
        pg.goto(host['url']);pg.get_by_text('加载示例').click()
        assert '陈家铺' in pg.locator('#brief').input_value()
        pg.locator('#brief').fill('invalid');pg.locator('#submit-btn').click()
        expect(pg.get_by_role('alert')).to_contain_text('未取得足够')
        pg.locator('#brief').fill(host['brief']);pg.locator('#submit-btn').click()
        frame=pg.frame_locator('#preview')
        expect(frame.locator('h1')).to_have_text('深圳社区图书馆')
        expect(frame.locator('.source-link')).to_have_count(4)
        pg.keyboard.press('ArrowDown')
        expect(frame.locator('.page.active .case-title-cn')).to_have_text('测试案例 1')
        frame.locator('.page.active .source-link').click(trial=True)
        pg.keyboard.press('ArrowRight')
        expect(frame.locator('.page.active .c-dot.active')).to_have_attribute('data-idx','1')
        expect(frame.locator('.page.active .slide').nth(1)).to_contain_text('暂无图像')
        pg.keyboard.press('End')
        expect(frame.locator('.page.active .tph-cn')).to_have_text('运营策略')
        expect(frame.locator('section.page')).to_have_count(11)
        with pg.expect_popup() as pop: pg.get_by_text('在新窗口打开').click()
        pop.value.wait_for_load_state();expect(pop.value).to_have_title('深圳社区图书馆 — 前期案例研究')
        with pg.expect_download() as dl:pg.locator('#download').click()
        assert '深圳社区图书馆' in Path(dl.value.path()).read_text()
        assert not errors,errors
        print('Chromium',browser.version,'PASS: authentication, sample form, validation failure and retry, 11-page iframe, source links, case carousel, missing images, final takeaway, new window, HTML download.')
        browser.close()
finally:
    app.terminate();app.wait(timeout=8)
