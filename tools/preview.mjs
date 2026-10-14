// # 无需 npm 安装，只使用 Node.js 内置模块启动本地预览。
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/bg.png', ['bg.png', 'image/png']],
    ['/music.js', ['music.js', 'text/javascript; charset=utf-8']],
    ['/rock.mp3', ['rock.mp3', 'audio/mpeg']],
    ['/DJ.mp3', ['DJ.mp3', 'audio/mpeg']],
]);

// # 只提供网页需要的文件，避免将 .git 或其他项目资料暴露给浏览器。
export function createPreviewServer() {
    return createServer(async (request, response) => {
        if (!['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();
            return;
        }
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
        if (pathname === '/favicon.ico') {
            response.writeHead(204).end();
            return;
        }
        const file = files.get(pathname);
        if (!file) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('文件不存在');
            return;
        }
        try {
            const location = new URL(file[0], root);
            const { size } = await stat(location);
            const headers = { 'Content-Type': file[1], 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
            let start = 0;
            let end = size - 1;
            let status = 200;
            // # 浏览器拖动音频进度时，会请求文件的一段字节，返回 206 即可续播。
            if (request.method === 'GET' && request.headers.range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
                const invalidRange = () => response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
                if (!match || (!match[1] && !match[2]) || size === 0) {
                    invalidRange();
                    return;
                }
                if (match[1]) {
                    start = Number(match[1]);
                    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
                } else {
                    const suffix = Number(match[2]);
                    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
                        invalidRange();
                        return;
                    }
                    start = Math.max(0, size - suffix);
                }
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
                    invalidRange();
                    return;
                }
                status = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }
            headers['Content-Length'] = Math.max(0, end - start + 1);
            response.writeHead(status, headers);
            if (request.method === 'HEAD' || size === 0) {
                response.end();
                return;
            }
            const stream = createReadStream(location, { start, end });
            stream.on('error', () => response.destroy());
            response.on('close', () => stream.destroy());
            stream.pipe(response);
        } catch (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('文件暂时不可用');
        }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const port = Number(process.argv[2] ?? 5173);
    const server = createPreviewServer();
    server.on('error', error => {
        console.error(`预览启动失败：${error.message}`);
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
        console.log(`本地预览：http://127.0.0.1:${server.address().port}`);
        console.log('按 Ctrl+C 停止。');
    });
}
