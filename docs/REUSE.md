# 复用审计

| 候选 | 核对内容 | 选择 |
| --- | --- | --- |
| [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)、[API](https://github.com/obsidianmd/obsidian-api) | 官方插件 manifest、ItemView、Modal、Vault Adapter 与 esbuild 模式 | 复用 API 和构建模式。移动侧不加载 Node、Electron 或联网依赖。 |
| [Fast Note Sync](https://github.com/haierkeys/obsidian-fast-note-sync) / [Service](https://github.com/haierkeys/fast-note-sync-service) | Apache-2.0。插件仓库提供跨端 Markdown 同步。服务有 REST、MCP、笔记版本历史。已安装 2.4.0 | 复用文件同步。独立修订保留业务级冲突。通用远程 MCP 权限大，未配置给小鱼。 |
| [QuickAdd](https://github.com/chhoumann/quickadd) | MIT。提供模板、捕获、脚本和宏 | 可用于普通笔记捕获。生命周期、不可变权重和业务权限仍由 LifePilot 处理。 |
| [Life Tracker Base View](https://github.com/dsebastien/obsidian-life-tracker-base-view) | MIT。用于时间序列属性的收集及展示 | 适合消费简化数据。直接读取修订会把同日多个历史版本同时算入，因此 LifePilot 自己折叠当前修订并导出 CSV。 |
| [Day Planner](https://github.com/ivan-lednev/obsidian-day-planner)、[Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) | MIT。日历、时间块、计时、Markdown 任务查询。已有成熟的任务表示 | 可作为课表或事务的参考。权重、成果分级和周池联动留在 LifePilot，防止同类任务多源写入。 |
| [Daily Notes](https://obsidian.md/help/plugins/daily-notes)、[Templates](https://obsidian.md/help/plugins/templates)、[Bases](https://obsidian.md/help/bases) | Obsidian 内置普通 Markdown、属性和数据库视图 | 继续使用相同文件格式。LifePilot 日记路径明确，可用模板维护日记布局。评分不从自由文本逆向计算。 |
| [DSH Calendar](https://github.com/AloneFu/dsh-calendar-plugin)、[DSH 官方 MCP 和 Schedule](https://github.com/deepseek-ai/deepseek-harness) | Calendar 的写回覆盖日记原文和 Markdown 待办。官方 MCP 可限制到独立业务工具。已核对实际随包 MCP client 与 Schedule | 选择官方 MCP 与 Schedule。避免向小鱼引入日记读写权限或维护第二个调度器。 |

上述项目的维护信息根据公开仓库、源码目录、发布入口和本机已安装版本核对。未 Fork、重新分发或加载候选第三方插件。FNS 与 DSH 由用户从各自渠道安装。

运行依赖为 Zod（MIT）和 MCP TypeScript SDK（MIT）。构建依赖由 `package-lock.json` 锁定，Obsidian API 以开发类型和宿主外部模块方式使用。发行包保留 esbuild 提取的依赖声明与 Zod 的 MIT 文本。DSH 模块运行依赖由 npm 安装，随其包提供上游许可证。
