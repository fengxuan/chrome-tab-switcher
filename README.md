# Chrome Tab Switcher

Chrome Tab Switcher 是一个本地运行的 Chrome 标签页和 macOS 窗口切换器：

- 在 Chrome 中集中查看多个窗口的标签页；
- 在 macOS 上统一查看 Finder、Visual Studio Code、Terminal 等应用窗口；
- 支持搜索应用名、窗口标题、标签页标题、网址和中文拼音；
- 收藏夹会记录本机观察到的访问次数，并优先显示最近访问的书签；
- 支持鼠标、键盘和全局快捷键切换；
- 所有标签页、窗口标题和网页内容只在本机处理。

macOS 窗口功能由 Swift Helper 和 Chrome Native Messaging 提供。只想管理 Chrome 标签页时，不需要安装 macOS Helper。

## 系统要求

### Chrome 标签页功能

- Google Chrome；
- 支持 Manifest V3 的 Chrome 版本；
- Windows、Linux 和 macOS 均可使用。

### macOS 窗口功能

- macOS 12 或更高版本；
- Swift/Xcode Command Line Tools，用于构建 Helper；
- “系统设置 → 隐私与安全性 → 辅助功能”权限。

## 安装 Chrome 扩展

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择项目中的 `chrome-tab-switcher` 目录，也就是包含 `manifest.json` 的目录。

安装完成后，可以点击工具栏中的扩展图标打开切换器。

默认快捷键：

- macOS：`Command + Shift + Space`；
- Windows/Linux：`Ctrl + Shift + Space`；
- 收藏夹视图：macOS 使用 `Command + Shift + F`，Windows/Linux 使用 `Ctrl + Shift + F`。
- 仅显示 macOS 原生应用：`Command + Shift + G`（Windows/Linux 为 `Ctrl + Shift + G`，无 macOS 应用时为空）。

如果 Chrome 提示快捷键已被占用，可以打开 `chrome://extensions/shortcuts` 修改快捷键。

## 安装 macOS Helper

macOS Helper 让你可以从 Finder、VS Code、Terminal 等其它应用中打开切换器，并读取和激活 macOS 应用窗口。

### 1. 构建 Helper

在终端进入 macOS Helper 目录：

```sh
cd /path/to/chrome-tab-project/macos/ChromeTabSwitcherHotKey
chmod +x build-app.sh install-native-host.sh
./build-app.sh
```

请把 `/path/to/chrome-tab-project` 替换为项目实际路径。构建成功后会生成：

```text
macos/ChromeTabSwitcherHotKey/dist/Chrome Tab Switcher.app
```

### 2. 启动 Helper 并自动安装 Native Messaging host

当前扩展 manifest 已固定本地开发扩展 ID。启动菜单栏 Helper 时，它会自动创建或更新：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.chrometabswitcher.v2.json
```

启动菜单栏 Helper：

```sh
open "dist/Chrome Tab Switcher.app"
```

如果自动安装失败，也可以使用备用脚本手动安装：

```sh
./install-native-host.sh
```

如果 `chrome://extensions/` 中显示的扩展 ID 与默认值不同，请把实际 ID 作为参数传入：

```sh
./install-native-host.sh your-32-character-extension-id
```

扩展 ID 必须从 Chrome 的扩展管理页面复制，不要自行输入其它字符串。

### 3. 授权并验证

然后打开：

```text
系统设置 → 隐私与安全性 → 辅助功能
```

开启“Chrome Tab Switcher”。如果列表中没有该应用，可以点击“+”，选择：

```text
macos/ChromeTabSwitcherHotKey/dist/Chrome Tab Switcher.app
```

授权后，在 Chrome 的 `chrome://extensions/` 页面点击扩展的“重新加载”。必要时退出并重新打开菜单栏中的 Chrome Tab Switcher。

### 4. 验证

1. 打开多个 Finder、VS Code 或 Terminal 窗口。
2. 在任意应用中按 `Command + Shift + Space`。
3. 在切换器中搜索应用名或窗口标题。
4. 点击窗口卡片，或选中后按 `Enter`。

按 `Command + Shift + G` 可直接打开仅包含 macOS 原生应用窗口的视图。

macOS Helper 运行后会显示在菜单栏中。它需要保持运行，才能从其它应用监听全局快捷键和激活窗口。

## 快捷键同步

扩展快捷键和 macOS Helper 中对应功能的快捷键必须一致。

菜单栏 Helper 的“分别设置快捷键…”可以为普通切换器、收藏夹、原生应用三个功能分别录入快捷键。修改后，还需要在 `chrome://extensions/shortcuts` 中把“Chrome Tab Switcher”的三个命令分别改成相同组合。

## 使用方式

- `←` / `→`：在当前行内移动；
- `↑` / `↓`：切换上一行或下一行；
- `Tab` / `Shift + Tab`：按卡片顺序移动；
- `Enter`：激活选中的 Chrome 标签页或 macOS 窗口；
- `⌘ K` / `Ctrl K`：聚焦搜索框；
- `Esc`：关闭切换器；
- 点击卡片右上角的 `×`：关闭 Chrome 标签页；
- 点击星标 `Favorites`：只查看收藏夹；点击收藏卡片右上角的星标可取消收藏。
- 收藏夹视图中的“最近访问”标记和筛选：显示最近 30 天内访问过的书签；这些书签会按最近访问时间优先排列。

搜索支持：

- Chrome 标签页标题、网址和 Chrome 窗口；
- macOS 应用名和窗口标题；
- 中文完整拼音和拼音首字母。

如果 Native Messaging host 未安装或辅助功能权限未开启，切换器会自动降级为只显示 Chrome 标签页。

## 更新项目

修改扩展代码后：

1. 在 `chrome://extensions/` 点击扩展的“重新加载”；
2. 重新打开切换器。

修改 macOS Helper 后：

```sh
cd /path/to/chrome-tab-project/macos/ChromeTabSwitcherHotKey
./build-app.sh
open "dist/Chrome Tab Switcher.app"
```

Helper 启动时会自动更新 Native Messaging host 配置。

如果 macOS 不再显示窗口，先退出旧的菜单栏 Helper，再打开新生成的 app，并检查辅助功能权限是否仍然开启。

## 卸载

### 卸载 Chrome 扩展

1. 打开 `chrome://extensions/`；
2. 找到 Chrome Tab Switcher；
3. 点击“移除”。

### 卸载 macOS Helper

1. 从菜单栏退出 Chrome Tab Switcher；
2. 删除 Native Messaging host 配置：

```sh
rm "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.chrometabswitcher.v2.json"
```

3. 删除项目中的 `macos/ChromeTabSwitcherHotKey/dist/Chrome Tab Switcher.app`（如果不再需要）。

## 常见问题

### 只显示 Chrome 标签页

确认以下步骤均已完成：

1. 已执行 `./build-app.sh`；
2. 已启动菜单栏 Helper，并允许它自动安装 Native Messaging host；
3. 菜单栏中正在运行 Chrome Tab Switcher；
4. 已在辅助功能设置中授权；
5. 已重新加载 Chrome 扩展。

### 提示未检测到 macOS Helper

通常是 Native Messaging host 未安装，或 host 配置中的扩展 ID 不正确。先退出并重新打开菜单栏 Helper，让它自动安装；仍失败时执行：

```sh
./install-native-host.sh
```

如果扩展 ID 不同，则执行：

```sh
./install-native-host.sh your-32-character-extension-id
```

### 提示需要辅助功能权限

打开“系统设置 → 隐私与安全性 → 辅助功能”，开启 Chrome Tab Switcher，然后重新打开 Helper 和扩展面板。

### 全局快捷键没有反应

检查菜单栏 Helper 是否正在运行，以及快捷键是否与其它应用、系统功能或 Chrome 扩展冲突。修改快捷键后，必须同时更新 Chrome 的扩展快捷键。

## 权限与隐私

Chrome 扩展使用以下权限：

- `tabs`、`windows`：读取和切换 Chrome 标签页及窗口；
- `bookmarks`：读取收藏夹；
- `nativeMessaging`：通过本机 Swift Helper 读取和激活 macOS 窗口；
- HTTP/HTTPS host 权限：仅在收藏夹缺少 favicon 时请求网站根目录的 `/favicon.ico`。

macOS Helper 使用 Accessibility API 读取窗口标题、窗口位置并激活具体窗口。标签页信息、窗口信息和网页内容不会上传到第三方服务。

## 打包扩展

在 `chrome-tab-switcher` 目录执行：

```sh
chmod +x build-extension.sh
./build-extension.sh
```

脚本会生成 `dist/chrome-tab-switcher.zip`。压缩包根目录直接包含 `manifest.json`，可用于发布或备份。
