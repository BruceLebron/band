// # audio 负责播放，AnalyserNode 读取真实频谱，Canvas 负责绘图。
const players = [...document.querySelectorAll('.track-card audio')];
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const graphs = new WeakMap();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let audioContext;

async function prepareAudioGraph(player) {
    // # file:// 下的音频可能被 Web Audio 的跨源规则静音，保留原生试听。
    if (!AudioContextClass || location.protocol === 'file:') return null;
    audioContext ??= new AudioContextClass();
    if (audioContext.state !== 'running') await audioContext.resume();
    if (audioContext.state !== 'running') return null;
    // # 同一 audio 只能创建一个 MediaElementSource；暂停与切歌后复用它。
    if (graphs.has(player)) return graphs.get(player);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -30;
    const source = audioContext.createMediaElementSource(player);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    const graph = { analyser, samples: new Uint8Array(analyser.frequencyBinCount), sampleRate: audioContext.sampleRate };
    graphs.set(player, graph);
    return graph;
}

for (const player of players) {
    const card = player.closest('.track-card');
    const status = card.querySelector('.track-status');
    const canvas = card.querySelector('.track-spectrum');
    const context = canvas.getContext('2d');
    const indicator = card.querySelector('.spectrum-indicator');
    const art = card.querySelector('.track-art');
    const accent = getComputedStyle(art).getPropertyValue('--spectrum-color').trim();
    const barCount = 48;
    const peaks = new Float32Array(barCount);
    let graph;
    let frame = 0;
    let lastDraw = 0;
    let visible = false;

    const setStatus = (state, text) => {
        card.dataset.state = state;
        status.textContent = text;
    };
    const setVisualizer = (state, text) => {
        card.dataset.visualizer = state;
        indicator.textContent = text;
    };

    function drawSpectrum(active = false) {
        if (!context) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const ratio = Math.min(devicePixelRatio || 1, 2);
        // # 像素尺寸随容器和屏幕密度变化，手机旋转后也不会拉伸或模糊。
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
            canvas.width = Math.round(width * ratio);
            canvas.height = Math.round(height * ratio);
        }
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.strokeStyle = '#f3f0e812';
        context.lineWidth = 1;
        for (let row = 1; row <= 3; row++) {
            const y = Math.round(height * row / 4) + 0.5;
            context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
        }
        const gradient = context.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, accent);
        gradient.addColorStop(1, '#f3f0e8');
        const step = width / barCount;
        const barWidth = Math.max(1, step * 0.64);
        if (active && graph) graph.analyser.getByteFrequencyData(graph.samples);
        for (let bar = 0; bar < barCount; bar++) {
            let strength = 0;
            if (active && graph) {
                // # 对数分组：低频鼓点到高频镲片都有足够的显示空间。
                const binHz = graph.sampleRate / graph.analyser.fftSize;
                const maxHz = Math.min(16000, graph.sampleRate / 2);
                const from = Math.max(1, Math.floor(40 * (maxHz / 40) ** (bar / barCount) / binHz));
                const to = Math.min(graph.samples.length, Math.max(from + 1, Math.ceil(40 * (maxHz / 40) ** ((bar + 1) / barCount) / binHz)));
                let sum = 0;
                for (let bin = from; bin < to; bin++) sum += graph.samples[bin] ** 2;
                strength = Math.sqrt(sum / (to - from)) / 255;
            }
            const barHeight = Math.max(3, strength * (height - 12));
            const x = bar * step + (step - barWidth) / 2;
            context.fillStyle = active ? gradient : '#f3f0e82a';
            context.fillRect(x, height - barHeight, barWidth, barHeight);
            if (active && strength > 0) {
                peaks[bar] = Math.max(barHeight, peaks[bar] - height * 0.025);
                context.fillStyle = '#f3f0e899';
                context.fillRect(x, height - peaks[bar] - 4, barWidth, 1);
            }
        }
    }

    function stopVisualization(reset = false) {
        cancelAnimationFrame(frame);
        frame = 0;
        lastDraw = 0;
        if (reset) {
            peaks.fill(0);
            drawSpectrum();
        }
    }
    function animate(timestamp) {
        frame = 0;
        if (!graph || player.paused || player.ended || !visible || document.hidden) return;
        // # 正常最多 30 帧/秒；减少动态效果时降到 8 帧/秒。
        if (timestamp - lastDraw >= (reducedMotion.matches ? 125 : 1000 / 30)) {
            drawSpectrum(true);
            lastDraw = timestamp;
        }
        frame = requestAnimationFrame(animate);
    }
    function startVisualization() {
        if (!frame && graph && !player.paused && visible && !document.hidden) frame = requestAnimationFrame(animate);
    }
    async function enableVisualization() {
        try {
            graph = await prepareAudioGraph(player);
            if (!graph || !context) {
                setVisualizer('unavailable', '频谱暂不可用');
                return;
            }
            if (!player.paused) {
                setVisualizer('live', '实时频谱');
                startVisualization();
            }
        } catch {
            // # 可视化不可用时，播放器的错误提示与原生控制继续工作。
            setVisualizer('unavailable', '频谱暂不可用');
        }
    }

    // # 在用户点击/按键时唤醒 AudioContext，兼容浏览器的播放权限策略。
    for (const event of ['pointerdown', 'keydown']) player.addEventListener(event, enableVisualization);
    new ResizeObserver(() => drawSpectrum(Boolean(graph && !player.paused))).observe(canvas);
    new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting;
        if (visible) startVisualization(); else stopVisualization();
    }).observe(art);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopVisualization(); else startVisualization();
    });
    setVisualizer('idle', '待播放');
    drawSpectrum();

    player.addEventListener('play', () => {
        // # 播放一首时暂停其他歌曲，避免两个声音同时响起。
        for (const other of players) {
            if (other !== player) other.pause();
        }
        setStatus('loading', '正在加载音频…');
        enableVisualization();
    });
    player.addEventListener('playing', () => {
        setStatus('playing', '正在播放');
        if (graph) { setVisualizer('live', '实时频谱'); startVisualization(); }
    });
    player.addEventListener('waiting', () => {
        if (!player.paused) {
            setStatus('loading', '正在缓冲…');
            stopVisualization(true);
            setVisualizer('loading', '缓冲中');
        }
    });
    player.addEventListener('pause', () => {
        stopVisualization(true);
        setVisualizer('idle', player.ended ? '播放结束' : '已暂停');
        if (!player.ended && !player.error && card.dataset.state !== 'error') setStatus('paused', '已暂停');
    });
    player.addEventListener('ended', () => {
        stopVisualization(true);
        setVisualizer('idle', '播放结束');
        setStatus('ended', '试听结束，可以重新播放');
    });
    player.addEventListener('loadstart', () => {
        stopVisualization(true);
        setVisualizer('idle', '待播放');
        if (player.paused) setStatus('idle', '点击播放，开始试听');
    });
    const showError = () => {
        stopVisualization(true);
        setVisualizer('idle', '待播放');
        setStatus('error', '音频暂时无法播放，请刷新后重试。');
    };
    player.addEventListener('error', showError);
    // # source 加载失败时，其错误事件不会冒泡到 audio，因此也需要监听。
    player.querySelector('source')?.addEventListener('error', showError);
}
