// # Node.js 22+；调用本机 Edge/Chrome 检查页面，不安装运行时依赖。
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from './preview.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const qa = join(root, '.qa');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { cssDiagnostics: null, viewports: [], checks: [] };
await mkdir(qa, { recursive: true });

// # 使用 VS Code 自带的 CSS 语言服务，检查与编辑器相同的诊断。
async function checkCss() {
    const bases = [join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft VS Code'), join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code')];
    let executable;
    for (const base of bases) {
        const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
        for (const prefix of ['', ...entries.filter(entry => entry.isDirectory()).map(entry => entry.name)]) {
            const candidate = join(base, prefix, 'resources/app/extensions/css-language-features/server/dist/node/cssServerMain.js');
            if (await access(candidate).then(() => true, () => false)) executable = candidate;
        }
    }
    if (!executable) {
        console.log('未找到 VS Code CSS 语言服务，跳过编辑器诊断；继续浏览器检查。');
        return;
    }
    const child = spawn(process.execPath, [executable, '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const uri = new URL('../style.css', import.meta.url).href;
    let buffer = Buffer.alloc(0);
    let resolveDiagnostics;
    let rejectDiagnostics;
    const diagnostics = new Promise((resolve, reject) => { resolveDiagnostics = resolve; rejectDiagnostics = reject; });
    const send = message => {
        const json = JSON.stringify({ jsonrpc: '2.0', ...message });
        child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    };
    child.on('error', rejectDiagnostics);
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const boundary = buffer.indexOf('\r\n\r\n');
            if (boundary < 0) break;
            const length = Number(buffer.subarray(0, boundary).toString().match(/Content-Length: (\d+)/i)[1]);
            if (buffer.length < boundary + 4 + length) break;
            const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());
            buffer = buffer.subarray(boundary + 4 + length);
            if (message.id === 1 && message.result) {
                send({ method: 'initialized', params: {} });
                readFile(join(root, 'style.css'), 'utf8').then(text => send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'css', version: 1, text } } }));
            } else if (message.method === 'textDocument/publishDiagnostics' && message.params.uri === uri) {
                resolveDiagnostics(message.params.diagnostics);
            } else if (message.method && message.id != null) {
                send({ id: message.id, result: null });
            }
        }
    });
    const timer = setTimeout(() => rejectDiagnostics(new Error('CSS 语言服务超时')), 12000);
    try {
        send({ id: 1, method: 'initialize', params: { processId: process.pid, rootUri: new URL('../', import.meta.url).href, capabilities: {} } });
        report.cssDiagnostics = await diagnostics;
        assert.equal(report.cssDiagnostics.length, 0, JSON.stringify(report.cssDiagnostics));
        console.log('PASS：VS Code CSS 诊断为 0');
    } finally {
        clearTimeout(timer);
        child.kill();
    }
}

await checkCss();
const server = createPreviewServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
let socket;
let cdp;
try {
    // # 校验实际 MP3 的 MIME、HEAD 与 Range 响应，保证进度条可以跳转。
    for (const filename of ['rock.mp3', 'DJ.mp3']) {
        const bytes = await readFile(join(root, filename));
        const head = await fetch(`${url}/${filename}`, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('content-type'), 'audio/mpeg');
        assert.equal(Number(head.headers.get('content-length')), bytes.length);
        for (const [range, start, end] of [['bytes=0-255', 0, 255], ['bytes=-128', bytes.length - 128, bytes.length - 1], [`bytes=${bytes.length - 64}-`, bytes.length - 64, bytes.length - 1]]) {
            const response = await fetch(`${url}/${filename}`, { headers: { Range: range } });
            assert.equal(response.status, 206);
            assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
        }
        for (const range of [`bytes=${bytes.length}-`, 'bytes=-0', 'bytes=9-3', 'bytes=abc-def']) {
            const response = await fetch(`${url}/${filename}`, { headers: { Range: range } });
            assert.equal(response.status, 416);
            await response.arrayBuffer();
        }
    }
    const privateFile = await fetch(`${url}/.git/config`);
    assert.equal(privateFile.status, 404);
    await privateFile.arrayBuffer();
    report.checks.push('两首 MP3 的 HEAD、字节范围内容、无效范围与私有路径保护');
    console.log('PASS：两首 MP3 的分段读取与音频响应头正常');
    const candidates = [process.env.BAND_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean);
    let browserPath;
    for (const candidate of candidates) {
        if (await access(candidate).then(() => true, () => false)) { browserPath = candidate; break; }
    }
    assert.ok(browserPath, '未找到 Edge/Chrome；可通过 BAND_BROWSER 指定浏览器可执行文件。');
    const profile = await mkdtemp(join(tmpdir(), 'band-check-'));
    browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--mute-audio', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100; i++) {
        const content = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
        if (content) { port = Number(content.split('\n')[0]); break; }
        await delay(100);
    }
    assert.ok(port, '浏览器启动失败');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    const browserErrors = [];
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id) {
            const request = pending.get(message.id);
            pending.delete(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
        } else if (message.method === 'Runtime.exceptionThrown') browserErrors.push(message.params);
    });
    cdp = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器命令超时：${method}`)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression, options = {}) => {
        const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...options });
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    // # 只在测试页面中记录真实分析器的输出，验证柱子确实来自 MP3。
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.__vizTest = { nodes: [], sourceCounts: {} };
        const analyserFactory = AudioContext.prototype.createAnalyser;
        AudioContext.prototype.createAnalyser = function (...args) {
            const node = analyserFactory.apply(this, args);
            const stats = { reads: 0, nonzero: false, signatures: new Set() };
            const read = node.getByteFrequencyData.bind(node);
            node.getByteFrequencyData = array => {
                read(array);
                stats.reads++;
                stats.nonzero ||= array.some(value => value > 0);
                if (stats.signatures.size < 20) stats.signatures.add(array.reduce((sum, value, index) => sum + value * (index + 1), 0));
            };
            __vizTest.nodes.push(stats);
            return node;
        };
        const sourceFactory = AudioContext.prototype.createMediaElementSource;
        AudioContext.prototype.createMediaElementSource = function (element) {
            const source = sourceFactory.call(this, element);
            __vizTest.sourceCounts[element.id] = (__vizTest.sourceCounts[element.id] || 0) + 1;
            return source;
        };
    ` });
    await cdp('Page.navigate', { url });
    await evaluate('new Promise(resolve => { if (document.readyState === "complete") resolve(); else window.addEventListener("load", resolve, {once:true}); })');
    const initialAudio = await evaluate(`({count: document.querySelectorAll('audio').length, idle: [...document.querySelectorAll('audio')].every(audio => audio.paused && !audio.autoplay && audio.preload==='none' && audio.controls)})`);
    assert.equal(initialAudio.count, 2);
    assert.ok(initialAudio.idle, '音频应等待用户主动播放');
    await evaluate(`window.bandWaitFor = predicate => new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => { if (predicate()) resolve(); else if (Date.now() > deadline) reject(new Error('等待音频状态超时')); else setTimeout(poll, 30); };
        poll();
    })`);
    report.audio = await evaluate(`(async () => {
        const audio = [...document.querySelectorAll('audio')];
        // # 用浏览器 --mute-audio 静音输出，保持分析器可读取完整音频信号。
        audio.forEach(player => { player.preload = 'metadata'; player.load(); });
        await bandWaitFor(() => audio.every(player => Number.isFinite(player.duration) && player.duration > 0));
        return audio.map(player => ({file: new URL(player.currentSrc).pathname, duration: player.duration}));
    })()`);
    await evaluate(`(async () => {
        const first = document.getElementById('track-rock');
        first.closest('.track-card').scrollIntoView({behavior:'instant', block:'center'});
        first.currentTime = 15;
        await first.play();
        await bandWaitFor(() => first.currentTime > 15 && first.closest('.track-card').dataset.state==='playing');
        await bandWaitFor(() => __vizTest.nodes[0]?.nonzero && __vizTest.nodes[0].signatures.size >= 3);
        scrollTo({top:0, behavior:'instant'});
        await new Promise(resolve=>setTimeout(resolve,100));
        const hiddenReads=__vizTest.nodes[0].reads;
        await new Promise(resolve=>setTimeout(resolve,200));
        if (__vizTest.nodes[0].reads!==hiddenReads) throw new Error('滚动离开后频谱仍持续绘图');
        first.closest('.track-card').scrollIntoView({behavior:'instant',block:'center'});
        await bandWaitFor(()=>__vizTest.nodes[0].reads>hiddenReads);
    })()`, { userGesture: true });
    await cdp('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
    const reducedFrames = await evaluate(`(async()=>{const before=__vizTest.nodes[0].reads;await new Promise(resolve=>setTimeout(resolve,400));return __vizTest.nodes[0].reads-before;})()`);
    assert.ok(reducedFrames>0 && reducedFrames<=5, '减少动态效果时绘图未降频');
    await cdp('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'no-preference'}] });
    await evaluate(`(async () => {
        const first = document.getElementById('track-rock');
        const second = document.getElementById('track-dj');
        second.closest('.track-card').scrollIntoView({behavior:'instant', block:'center'});
        second.currentTime = 15;
        await second.play();
        await bandWaitFor(() => first.paused && second.currentTime > 0 && second.closest('.track-card').dataset.state==='playing');
        if (first.closest('.track-card').dataset.state !== 'paused') throw new Error('第一首的暂停状态未更新');
        await bandWaitFor(() => __vizTest.nodes[1]?.nonzero && __vizTest.nodes[1].signatures.size >= 3);
        second.currentTime = second.duration / 2;
        await bandWaitFor(() => !second.seeking && Math.abs(second.currentTime-second.duration/2)<2);
        second.pause();
        await bandWaitFor(() => second.closest('.track-card').dataset.state==='paused');
        const canvas = second.closest('.track-card').querySelector('canvas');
        const frozen = canvas.toDataURL();
        await new Promise(resolve => setTimeout(resolve, 200));
        if (frozen !== canvas.toDataURL()) throw new Error('暂停后频谱仍在跳动');
    })()`, { userGesture: true });
    report.spectrum = await evaluate(`({nodes: __vizTest.nodes.map(stats=>({reads:stats.reads, nonzero:stats.nonzero, distinctFrames:stats.signatures.size})), sourceCounts: __vizTest.sourceCounts})`);
    assert.ok(report.spectrum.nodes.every(node => node.nonzero && node.distinctFrames >= 3));
    assert.deepEqual(report.spectrum.sourceCounts, {'track-rock': 1, 'track-dj': 1});
    report.checks.push('两首音频的真实非零频谱、多个不同采样帧、暂停后画面静止、滚动离开停止和返回恢复、减少动态效果降频、音频节点无重复连接');
    console.log('PASS：两首音乐的真实频谱随音频变化，暂停后画面停止');
    // # 模拟音频源加载失败，验证 source 的错误事件也能显示提示。
    await evaluate(`(async () => {
        const player = document.getElementById('track-rock');
        const source = player.querySelector('source');
        source.src = 'missing-test.mp3'; player.load();
        await bandWaitFor(() => player.closest('.track-card').dataset.state==='error');
        source.src = 'rock.mp3'; player.load();
        await bandWaitFor(() => Number.isFinite(player.duration) && player.closest('.track-card').dataset.state==='idle');
    })()`);
    report.checks.push('两首 MP3 解码、播放进度、互斥播放、暂停、跳转进度、加载失败提示与恢复、无自动播放');
    console.log('PASS：两首音频可播放，切歌自动暂停，跳转进度与错误提示正常');
    // # 懒加载头像必须进入视口后再检查；等待解码完成，截图才不会留空。
    await evaluate(`(async () => {
        for (const image of document.images) {
            (image.closest('.member-avatar') ?? image).scrollIntoView({ behavior: 'instant', block: 'center' });
            await new Promise(resolve => requestAnimationFrame(resolve));
            await image.decode();
        }
        scrollTo({ top: 0, behavior: 'instant' });
    })()`);

    // # 核对 Markdown 原始资料，避免展示优化时漏掉成员和演出信息。
    const members = await readFile(join(root, 'members.md'), 'utf8');
    const tour = await readFile(join(root, 'tour.md'), 'utf8');
    const text = await evaluate('document.body.textContent');
    for (const match of members.matchAll(/^- (.+)$/gm)) assert.ok(text.includes(match[1].trim()), `遗漏成员资料：${match[1]}`);
    const summary = members.split('\n').find(line => line.startsWith('潮汐信号'));
    assert.ok(text.includes(summary.trim()));
    for (const match of tour.matchAll(/^\s*> 地点：(.+)$/gm)) assert.ok(text.includes(match[1].trim()));
    for (const match of tour.matchAll(/\*\*(.+?)站 \| (.+?)\*\*/g)) {
        assert.ok(text.includes(`${match[1]}站`)); assert.ok(text.includes(match[2]));
    }
    assert.ok(!text.includes('香港站'));
    const dates = await evaluate('[...document.querySelectorAll("time")].map(el => el.dateTime)');
    const sourceDates = [...tour.matchAll(/日期：(\d{4})年(\d+)月(\d+)日/g)].map(match => `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`);
    const sourceTimes = [...tour.matchAll(/时间：晚上(\d+):(\d+)/g)].map(match => `${String(Number(match[1]) + 12).padStart(2, '0')}:${match[2]}`);
    assert.deepEqual(dates, sourceDates.map((date, i) => `${date}T${sourceTimes[i]}:00+08:00`));
    for (const date of dates) assert.equal(new Date(date).getUTCDay(), 6, '周六标记不正确');
    const structure = await evaluate(`({
        h1: document.querySelectorAll('h1').length,
        members: document.querySelectorAll('.member-card').length,
        avatars: document.querySelectorAll('.member-avatar img').length,
        duplicateIds: [...document.querySelectorAll('[id]')].map(el=>el.id).filter((id,i,all)=>all.indexOf(id)!==i),
        brokenAnchors: [...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.hash.slice(1))).map(a=>a.hash),
        images: [...document.images].every(img=>img.complete && img.naturalWidth>0 && img.alt),
        cssLoaded: document.styleSheets.length===1 && document.styleSheets[0].cssRules.length>0
    })`);
    assert.equal(structure.h1, 1); assert.equal(structure.members, 4);
    assert.equal(structure.avatars, 4);
    assert.deepEqual(structure.duplicateIds, []); assert.deepEqual(structure.brokenAnchors, []);
    assert.ok(structure.images); assert.ok(structure.cssLoaded);
    report.checks.push('成员原文、四位成员头像加载、四场巡演日期/时间/场馆/地点、图片、样式、页面结构与锚点');

    for (const width of [320, 375, 600, 768, 960, 1024, 1440]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        const layout = await evaluate(`({
            width: innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
            memberColumns: getComputedStyle(document.querySelector('.members-grid')).gridTemplateColumns.split(' ').length,
            musicColumns: getComputedStyle(document.querySelector('.music-grid')).gridTemplateColumns.split(' ').length,
            clipped: [...document.querySelectorAll('nav a, h1, h2, h3, .member-bio, .show-venue, .event-info dd')].filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.textContent)
        })`);
        assert.ok(layout.scrollWidth<=layout.clientWidth, `${width}px 出现横向溢出`);
        assert.deepEqual(layout.clipped, [], `${width}px 内容被挤压`);
        assert.equal(layout.memberColumns, width<=600 ? 1 : width<=960 ? 2 : 4);
        assert.equal(layout.musicColumns, width<=600 ? 1 : 2);
        const canvasSizes = await evaluate(`[...document.querySelectorAll('.track-spectrum')].map(canvas=>({css:canvas.clientWidth,pixels:canvas.width,expected:Math.round(canvas.clientWidth*Math.min(devicePixelRatio,2))}))`);
        assert.ok(canvasSizes.every(size=>size.css>0 && size.pixels===size.expected), '频谱画布尺寸未适配屏幕');
        report.viewports.push(layout);
        if ([375, 768, 1440].includes(width)) {
            const metrics = await cdp('Page.getLayoutMetrics');
            const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: Math.ceil(metrics.cssContentSize.height), scale: 1 } });
            await writeFile(join(qa, `page-${width}.png`), Buffer.from(screenshot.data, 'base64'));
            const membersBox = await evaluate(`(() => { const rect = document.getElementById('members').getBoundingClientRect(); return {x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height}; })()`);
            const membersScreenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...membersBox, scale: 1 } });
            await writeFile(join(qa, `members-${width}.png`), Buffer.from(membersScreenshot.data, 'base64'));
            const musicBox = await evaluate(`(() => { const rect = document.getElementById('music').getBoundingClientRect(); return {x: rect.x, y: rect.y + scrollY, width: rect.width, height: rect.height}; })()`);
            const musicScreenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...musicBox, scale: 1 } });
            await writeFile(join(qa, `music-${width}.png`), Buffer.from(musicScreenshot.data, 'base64'));
            if ([375, 1440].includes(width)) {
                await cdp('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'no-preference'}] });
                await evaluate(`(async()=>{
                    const player=document.getElementById('track-rock');
                    player.closest('.track-card').scrollIntoView({behavior:'instant',block:'center'});
                    const before=__vizTest.nodes[0].reads;
                    player.currentTime=Math.min(30,player.duration/3);
                    await player.play();
                    await bandWaitFor(()=>!player.seeking && __vizTest.nodes[0].reads>before+8);
                    scrollTo({top:0,behavior:'instant'});
                })()`, { userGesture: true });
                const liveMusicScreenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...musicBox, scale: 1 } });
                await writeFile(join(qa, `spectrum-playing-${width}.png`), Buffer.from(liveMusicScreenshot.data, 'base64'));
                await evaluate('document.getElementById("track-rock").pause()');
            }
        }
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        assert.equal(await evaluate('getComputedStyle(document.documentElement).scrollBehavior'), 'auto');
        for (const anchor of ['#about', '#members', '#music', '#tour', '#show-hangzhou']) {
            const destination = await evaluate(`(async()=>{document.querySelector('a[href="${anchor}"]').click();await new Promise(resolve=>requestAnimationFrame(resolve));return {hash:location.hash,top:document.querySelector('${anchor}').getBoundingClientRect().top,headerBottom:document.querySelector('header').getBoundingClientRect().bottom};})()`);
            assert.equal(destination.hash, anchor);
            assert.ok(destination.top>=destination.headerBottom-1, `${width}px ${anchor} 被固定导航遮挡`);
        }
        await evaluate('scrollTo(0,0)');
        console.log(`PASS：${width}px 无横向溢出，卡片 ${layout.memberColumns} 列，导航跳转正常`);
    }
    // # 键盘用户按 Tab 后应能看到跳过导航的入口。
    await cdp('Page.navigate', { url });
    await evaluate('new Promise(resolve => { if(document.readyState==="complete")resolve();else addEventListener("load",resolve,{once:true}); })');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.ok(await evaluate('document.activeElement.matches(".skip-link") && document.activeElement.getBoundingClientRect().top >= 0'));
    assert.deepEqual(browserErrors, []);
    report.checks.push('7 种屏幕宽度、导航无遮挡、减少动态效果、键盘入口、无浏览器脚本异常');
    await writeFile(join(qa, 'report.json'), JSON.stringify(report, null, 2));
    console.log('PASS：全部检查完成，截图和报告位于 .qa/');
} finally {
    if (socket?.readyState === WebSocket.OPEN) {
        await cdp('Browser.close').catch(() => {});
        socket.close();
    }
    browser?.kill();
    await new Promise(resolve => server.close(resolve));
}
