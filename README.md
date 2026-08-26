# Chrome Tab Switcher

一个本地 Chrome Manifest V3 扩展，把多个 Chrome 窗口里的标签页集中到一个大横向面板中，方便用鼠标或键盘切换。

## 安装

1. 打开 Chrome：`chrome://extensions/`
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择当前目录下的 `chrome-tab-switcher` 文件夹。

安装后可以：

- 点击工具栏中的扩展图标打开面板；
- 使用快捷键 `Command + Shift + Space`（Windows/Linux 默认是 `Ctrl + Shift + Space`）；
- 自定义打开切换器的快捷键：打开 `chrome://extensions/shortcuts`，找到“Chrome Tab Switcher”，点击对应快捷键输入框后录入新的组合键；

## macOS 系统级快捷键

如果希望在 Excel、VS Code 等其它应用中也能唤出切换器，可以运行父目录 `macos/ChromeTabSwitcherHotKey` 中的本地辅助程序。它监听系统级 `Command + Shift + Space`，激活最近使用的 Chrome 窗口，然后把同一个快捷键发送给扩展。Chrome 没有运行时，辅助程序会尝试启动 Chrome。启动后，辅助程序会显示在 macOS 菜单栏中。

构建并运行：

```sh
cd ../macos/ChromeTabSwitcherHotKey
chmod +x build-app.sh
./build-app.sh
open "dist/Chrome Tab Switcher.app"
```

首次运行后，请在“系统设置 → 隐私与安全性 → 辅助功能”中允许“Chrome Tab Switcher”。这是 macOS 对跨应用发送键盘事件的权限要求。也可以从菜单栏中的“打开辅助功能设置”，或“更换全局快捷键”窗口中的“打开辅助功能设置”按钮直接跳转到授权页面。点击菜单栏中的 `⌘⇧Space`，可以打开切换器、查看监听状态、更换快捷键或退出程序。更换快捷键后，需要同时在 `chrome://extensions/shortcuts` 中将扩展快捷键设置成相同组合。录入新快捷键时，辅助程序会暂时停止监听旧快捷键，保存或取消后自动恢复。之后可以把 `dist/Chrome Tab Switcher.app` 加到“系统设置 → 通用 → 登录项”，让它开机常驻。

辅助程序使用的快捷键必须和扩展在 `chrome://extensions/shortcuts` 中的快捷键一致；默认都是 `Command + Shift + Space`。从其它应用触发时，“当前 Chrome 标签页”指 Chrome 最近一次使用的窗口及其中最近激活的标签页。

## 打包发布

在当前目录执行：

```sh
chmod +x build-extension.sh
./build-extension.sh
```

脚本会先检查扩展代码和 `manifest.json`，然后生成 `dist/chrome-tab-switcher.zip`。压缩包根目录直接包含 `manifest.json`，可直接上传到 Chrome Web Store；`dist/` 目录中的构建产物不会提交到 Git。

## 使用

- `←` / `→`：在当前行内切换标签页（合并窗口时可跨窗口切换）
- `Tab` / `Shift + Tab`：按面板中标签卡片的显示顺序连续或反向切换所有标签页
- `↑` / `↓`：切换上一行/下一行，并尽量保持横向位置
- `Enter`：激活选中的标签页，并切换到对应 Chrome 窗口
- 鼠标悬停标签卡片时，点击右上角 `×`：关闭该标签页
- `Esc`：关闭面板
- `⌘ K` / `Ctrl K`：聚焦搜索框
- 绿色小点：最近切换的 4 个标签页，或最近播放结束视频的标签页；左上角动画播放按钮：正在播放音频或视频的标签页
- 搜索框支持标题、网址和窗口名称，也支持中文标题的完整拼音和首字母查询；拼音使用本地打包的精简 pinyinjs 字典，并针对常见多音词做了小型补丁
- 点击其它 Chrome 窗口或其它应用后，面板会自动关闭；再次按快捷键会直接重新打开

面板会显示所有可访问的 Chrome 窗口中的标签页，并按每个窗口的标签数量从多到少排序；数量相同时优先当前窗口。仅包含空白新标签页的空窗口最多显示一个。所有少于 5 个标签的窗口都可以参与合并，同一行合计少于 10 个标签；窗口组之间会保留更大的间距。每个标签只显示网站图标和标题，不加载网页截图；单个窗口的标签过多时会自动换行，合并窗口行超过可用宽度时仍可横向滚动。弹出窗口会根据合并后的行数和标签数量动态调整宽度与高度，最多显示 7 行，窗口更多时中间的窗口列表支持纵向滚动。

弹出面板会默认居中到触发它的 Chrome 窗口所在屏幕，并使用 Chrome 的 popup 窗口类型，因此不会显示标签栏和地址栏。Chrome 扩展无法移除操作系统原生标题栏；如果需要完全无边框的桌面窗口，需要使用 Electron 或 Tauri 包装成独立桌面应用。

## 权限说明

扩展使用 `tabs` 和 `windows` 权限来读取跨窗口的标签标题、网址和网站图标，使用 `storage.session` 保存切换器窗口、最近标签和视频播放状态，以便 Manifest V3 service worker 重启后恢复。视频状态由本地 content script 监听网页原生视频的播放结束事件。拼音字典基于 MIT 许可的 pinyinjs，并随扩展本地打包；所有代码都在本地运行，不会上传标签信息或网页内容。
