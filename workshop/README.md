# 创意工坊目录

这个文件夹就是浮生氪劳德工作台的**创意工坊**。工作台默认从这里读取插件和皮肤的目录（`registry.json`），用户点「安装」时下载 `packages/` 里对应的插件包，并校验 sha256。

```text
workshop/
├── src/<id>/          # 作品源码，每个作品一个目录，目录名等于 manifest.json 里的 id
├── packages/          # 由 npm run workshop:build 生成，请勿手改
├── registry.json      # 由 npm run workshop:build 生成，请勿手改
└── official.json      # 由本项目维护的作品，只有维护者修改
```

## 投稿

1. 阅读 **[插件与皮肤开发指南](../docs/PLUGINS.md)**，用 `npm run plugin:new -- <id>`（皮肤加 `--theme`）开始。
2. 把作品放到 `workshop/src/<id>/`，在 `manifest.json` 里写明 `engines.workbench`，例如 `">=1.1.0"`。
3. 运行：

   ```bash
   npm run workshop:build             # 打包作品，更新 registry.json
   npm run workshop:build -- --check  # 确认目录是最新的（CI 也会检查）
   npm test
   ```

4. 提交 PR，说明作品做什么、为什么需要它申请的每一项权限，最好附一张截图。

更新作品时请先提升 `version`。审核标准、「官方」标记和自建目录的说明，见开发指南的 [上架创意工坊](../docs/PLUGINS.md#上架创意工坊) 一节。

> [!NOTE]
> 收录进创意工坊表示作品通过了审核，不代表本项目为其安全性背书。插件运行在隔离的沙箱里，只能使用你授予的权限，但请只安装你信任的作者的作品。详见 [安全模型](../docs/PLUGINS.md#安全模型)。
