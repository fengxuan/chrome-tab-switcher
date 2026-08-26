# pinyinjs vendor

这组文件来自 [sxei/pinyinjs](https://github.com/sxei/pinyinjs) 的浏览器版实现，
用于离线生成标签标题的完整拼音。

文件按以下顺序加载：

1. `pinyin_dict_withtone.js`
2. `pinyinUtil.js`

扩展代码另有一个很小的常见多音词补丁，用于处理浏览器标题中常见的“音乐、银行、重庆”等词；没有引入完整的多音词库，以控制扩展体积。

许可证见同目录的 `LICENSE` 文件。
