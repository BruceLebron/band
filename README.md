# 潮汐信号乐队网站

原生 HTML + CSS 单页网站，无框架、无外部字体或 CDN 依赖，支持离线浏览。

## 本地预览

最简单的方式：在文件资源管理器中双击 `index.html`。

也可以在 VS Code 中右键 `index.html`，选择 **Open with Live Server**。本机已安装该扩展。

使用 Node.js 启动预览：

```powershell
# 在 VS Code 终端中运行，保持终端开启
Set-Location 'D:\Vibe Coding\vscode\band'
node tools/preview.mjs

# 浏览器访问 http://127.0.0.1:5173
# 按 Ctrl+C 停止；端口被占用时可指定其他端口
# node tools/preview.mjs 5174
```

## 文件分工

| 文件 | 作用 |
| --- | --- |
| `index.html` | 网页结构、导航、成员、音乐试听与巡演展示 |
| `style.css` | 配色、字体、间距、交互状态与响应式布局 |
| `music.js` | 实时音频频谱、状态提示，以及播放一首时暂停另一首 |
| `rock.mp3`、`DJ.mp3` | 两首试听音频，直接引用项目内原文件 |
| `members.md` | 乐队与成员资料来源 |
| `tour.md` | 巡演资料来源，11 月 21 日已确认为杭州站 |
| `bg.png` | 保留的原始巡演海报 |
| `tools/preview.mjs` | 仅供本地开发的静态预览服务器 |
| `tools/check.mjs` | 自动检查页面并生成截图与报告 |

Markdown 文件不会自动加载到网页。修改成员或巡演资料时，请同步更新 `index.html` 与对应的 Markdown 文件。

## 关键代码怎么理解

### HTML：给内容建立结构

`header` 是页头，`nav` 是导航，`main` 是主体，`section` 是内容分区。链接 `href="#tour"` 会跳到 `id="tour"` 的巡演区，不需要 JavaScript。

海报使用 `img` 展示，提供文字说明与原始宽高，让浏览器在图片加载前预留空间。手机上完整缩放海报；具体巡演信息另以网页文字展示，方便阅读。

四位成员的圆形头像复用 `bg.png` 中的对应人物。`.member-avatar` 用 `overflow: hidden` 隐藏圆形窗口以外的区域，图片通过 `--avatar-x` / `--avatar-y` 定位人物面部；没有修改原海报。头像使用懒加载，同一个图片地址可复用浏览器缓存。

### CSS 变量：全站共用一组设计参数

```css
/* # 改一个变量，就能调整全站的强调色 */
:root {
    --accent: #ff543e;
}
```

### Grid：决定卡片如何排队

```css
/* # 电脑上每行四位成员；minmax(0, 1fr) 允许列随屏幕缩小 */
.members-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* # 手机每行一位成员 */
@media (max-width: 600px) {
    .members-grid {
        grid-template-columns: 1fr;
    }
}
```

实际断点：600px 及以下为单列，601–960px 为两列，960px 以上为四列。

`clamp(最小值, 随屏幕变化的值, 最大值)` 让字号与留白在合理范围内变化；`box-sizing: border-box` 让宽度包含内边距和边框。

键盘用户可通过 Tab 查看焦点和“跳到主要内容”入口。系统开启“减少动态效果”时，页面取消平滑滚动与过渡。

### 音乐试听

导航栏的“音乐试听”跳转到 `#music`。使用浏览器自带的播放器，可以播放、暂停、拖动进度条；支持的设备上还可以调节音量。页面不会自动播放音频。

```html
<!-- # controls 显示原生控制条；preload="none" 等待用户播放再加载 -->
<audio controls preload="none">
    <source src="rock.mp3" type="audio/mpeg">
</audio>
```

`music.js` 监听 `play` 事件，暂停另一首歌并保留它的播放位置。加载、播放、暂停、结束和失败状态会显示在控制条下方。

播放器上方的 48 根柱子来自实际音频：`MediaElementAudioSourceNode` 将 MP3 送入 `AnalyserNode`，读取频率强度后由 Canvas 绘图。左侧是低频，右侧是高频；某个频段越强，对应柱子越高。鼓点等声音会让柱子随之起伏，这不是固定动画或 BPM 识别。参考 [AnalyserNode 文档](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode)。

正常最多每秒绘制 30 帧；开启系统“减少动态效果”后降低到 8 帧。暂停、结束和加载失败时恢复静止，滚动离开频谱区或切换后台时停止绘图。改变浏览器尺寸时重新适配画布，屏幕像素密度最高按 2 倍绘制。

**查看实时频谱请使用 Live Server 或 Node 本地预览。** 双击 HTML 的 `file://` 模式保留普通试听，不接入 Web Audio，以避免浏览器跨源规则造成静音。不支持 Web Audio 时也保留原生播放器。

本地预览服务支持 HTTP Range：浏览器可以按需读取 MP3 的某一段，而无需将整个文件读入服务器内存。双击 HTML、Live Server 和 `node tools/preview.mjs` 均可预览试听区；新版本预览脚本需要停止旧进程后重新启动。

## 自动检查

需要 Node.js 22+ 及本机 Edge 或 Chrome，不需要 `npm install`。

```powershell
# 检查资料、资源、导航与 7 种屏幕宽度，并保存截图
node tools/check.mjs

# 可选：指定其他浏览器路径
# $env:BAND_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

检查涵盖成员原文、巡演日期与时间、场馆与地点、图片加载、锚点有效性、导航无遮挡、键盘入口和横向溢出。音频检查以静音方式验证两首 MP3 的解码与播放进度、切歌暂停、拖动进度、错误提示及恢复，并核对 HTTP Range 返回的实际字节。会尝试调用本机 VS Code 自带的 CSS 语言服务；找不到时明确报告跳过。

结果保存在 `.qa/report.json`，375px、768px、1440px 的页面截图，以及成员区和音乐区的截图保存在 `.qa/`。`spectrum-playing-375.png` 和 `spectrum-playing-1440.png` 是实际播放时的频谱截图。检查会验证两首音频都产生非零且变化的频谱，以及暂停后画面停止。该目录已加入 `.gitignore`。

用一句话理解：**HTML 放内容，CSS 安排外观与位置；屏幕变小，就让内容重新排列。**
