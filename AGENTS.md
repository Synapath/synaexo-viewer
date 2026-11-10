# SynaExo Viewer

- 本仓库是纯静态浏览器应用，不依赖 205、Python 服务或 S3 密钥。
- `src/` 为源码，`docs/` 为 `npm run build` 的生成产物及 GitHub Pages 发布源，不手工修改生成文件。变更源码后重建并核对相对资源路径。
- 沿用黑灰白 SynaExo 公共控件层级和现有 X 标志；不引入额外 UI 框架。交互验证优先使用合成 ZIP，并覆盖开发与生产子路径。
- ZIP、真实录制、凭据及带签名 URL 不进入 Git。经用户明确授权的默认 SMPL-X 模型可随 `public/models/` 及对应 `docs/models/` 构建产物入库发布；新增或替换模型仍需单独授权，其他模型权重不进入 Git。包内路径及 JSON 均视为数据，不执行其中代码、不自动请求远程资源。
- NPZ、坐标、时间轴和模型裁剪变更须与源结果对照验证，不以默认 FPS、坐标轴或手部均值冒充缺失证据。
- 所有实现、测试及最终 Review 由主 agent 直接完成。
- 常规开发直接在 `main` 上进行，不另建分支或 worktree；用户另行要求时除外。
- 本地验证：`npm test`、`npm run lint`、`npm run build`。推送 `main` 后，由 `.github/workflows/pages.yml` 检查、构建并发布 GitHub Pages，持续监控到部署完成。tag 和 GitHub Release 仍须用户单独要求。
