# LifePilot 1.0

LifePilot 把每周考研目标、每日四科保温、行动启动、生活打卡和复盘放进 Obsidian。五维分数由本地程序计算。DeepSeek 小鱼可通过 MCP 查询进度或提交提案，提案由用户在 Obsidian 批准。

LifePilot plans study goals, records daily habits, and reviews progress inside Obsidian. The plugin works offline without an account and stores records in the current vault. Fast Note Sync and DeepSeek Harness are optional, separately configured integrations.

## 安装

发行包提供已经构建的 `dist/obsidian/`。从源码构建需要 Node.js 22 或更新版本。

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

1. 先建一个测试 Vault。把 `dist/obsidian/` 内的 `main.js`、`manifest.json` 和 `styles.css` 放入测试 Vault 的 `.obsidian/plugins/lifepilot/`。随包保留依赖许可声明。
2. 在 Obsidian 的「设置 → 第三方插件」启用 LifePilot。打开罗盘图标或执行「LifePilot: 打开今日面板」。本机验证版本为 Windows Obsidian 1.15.0。Android、iOS 可使用相同产物，实机状态见验收表。
3. 同步时在各端安装相同插件版本并复用 Fast Note Sync。确认 FNS 未排除 `LifePilot/Data` 和 Markdown。需要同步日记时纳入 `LifePilot/Journal`。若日记需留在设备上，把该目录加入 FNS 排除列表。
4. 需要小鱼联动时，按 [DSH 和系统集成](docs/INTEGRATIONS.md) 配置。标准 Obsidian 功能可离线运行。

## 每天怎么用

打开「每日 → 记一下今天」，点选想记的几项并保存。运动、手机、复盘和睡眠时长可按需展开。想写几句时，点「打开日记」。每日首页将学习计划、分数和提醒折叠，需要时再打开。

「数据与设置」里有每日评分说明。周计划可展开查看栏目分，报告可展开查看分数趋势。日常记录只需点选想记的项目。

日期跟随系统生活日，补记可点「前一天」或「后一天」。时间用小时和分钟下拉菜单选择。每日学习和周计划都按学科切换。

1. 在「周计划」设置入睡时间、四科目标及任务池。入睡目标在该周首次生成生活日后锁定。
2. 在「每日」生成基础任务，可选记录可用学习时间。按时间和周目标缺口从周池选主攻任务。可用主攻覆盖同科保温。赴约和学习启动情况在「记一下今天」里点选。
3. 需要统计旧词时，用上下按钮和快捷加减设置最初待复习词数。也可以直接确认计划，本日旧词不计入分数。已记录成果但还没确认计划时，基础任务仍可记录。
4. 每张任务卡用同一个「记录成果」按钮。可点选完成、没做或部分完成。网课单独选择是否回忆，力扣新题选择对应的完成档位。实际用时可选填。
5. 可以只记一两项日常感受。未填写的项目显示「未记录」。选择「今天没有安排」时，履约显示「不适用」，当天参考满分相应减少。周报、月报和趋势 CSV 在「报告」。
6. 日期使用设备本地时间，凌晨 04:00 切换生活日。目标入睡时间若在 00:00–03:59，归前一个生活日。设备宜统一时区。

## 用 AI 导入周计划

「数据与设置 → 学习栏目」可新增和重命名主栏目、子栏目，用加减按钮设置每周目标分钟和栏目满分。每日计划和周计划共用栏目，已有每日任务可通过「调整任务 → 移动到栏目」重新归类。周计划显示选中栏目的进度与得分。目标和分值从保存当周起生效，主栏目进度包含其子栏目成果，各栏目的得分独立显示。每日学习仍按原量规结算。

1. 打开「周计划 → 导入 JSON → 查看规则和示例」，复制提示词给 AI，并补充本周想学的内容。
2. 粘贴生成的 JSON，也可以选本机的 `.json` 文件。导入周次以当前页面为准。
3. 同学科同类别的目标会更新，任务按同学科 `reference` 去重，保留已存在的任务和进度。格式错误或周休息时间已生效时，界面会提示；导入学习计划时可以省略 `bedtime`。

启用 Dayline Journal 后，「打开日记」优先打开该插件日记目录里当天的已有日记。若当天两边都没有日记，LifePilot 使用 Dayline 的日期与模板入口创建。若当天已有 LifePilot 日记且 Dayline 尚无同日文件，则继续打开已有记录。

## 数据与维护

- `LifePilot/Data/` 保存带 Properties 的 Markdown 修订。备份和导入入口在「数据与设置」。该业务备份涵盖修订和待审批提案，日记需另外复制 `LifePilot/Journal/`。
- 同步故障先看 FNS 的服务器状态，再在 LifePilot 检查本地数据。出现分支可预览两端内容并选择保留哪一个为当前版本，原分支继续留在历史中。缺失父修订时等另一设备同步，或从完整备份补回。
- 日常使用通过界面修改数据。直接编辑修订文件可能使校验失败。准备恢复时先备份当前 Vault，再在测试 Vault 验证恢复效果。
- 已用量规随生活日保存。新量规应用于新生成的生活日。最终分值见 [产品规范](docs/REQUIREMENTS.md)。
- 源码和阶段提交都在本地 Git 仓库。便携发行包内的 `LifePilot.bundle` 可用 `git clone LifePilot.bundle LifePilot` 恢复提交历史。

## 社区插件发布

根目录的 `manifest.json` 是 Obsidian 社区目录读取的版本信息。运行 `npm ci` 和 `npm run build`，用与 manifest 完全相同的版本号作为 GitHub Release 标签（例如 `1.0.7`）。从 `dist/obsidian/` 分别附上 `main.js`、`manifest.json`、`styles.css` 和依赖许可证。首次发布后，在 [Obsidian 社区目录](https://community.obsidian.md/) 提交仓库。

## 开发与验收

LifePilot 使用 MIT 许可证，详见 [LICENSE](LICENSE)。

`packages/core` 放规则与修订存储，`plugins/obsidian` 放本地界面，`plugins/dsh` 放 MCP，`integrations` 放配置样例，`tests` 和 `scripts` 放自动化验证。

- [实现与验证状态](docs/ACCEPTANCE.md)
- [架构与数据约定](docs/ARCHITECTURE.md)
- [复用和许可证](docs/REUSE.md)
