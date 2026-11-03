# SynaExo Viewer

- 本仓库是纯静态浏览器应用，不依赖 205、Python 服务或 S3 密钥。
- `src/` 为源码，`docs/` 为 `npm run build` 的生成产物及 GitHub Pages 发布源，不手工修改生成文件。变更源码后重建并核对相对资源路径。
- 沿用黑灰白 SynaExo 公共控件层级和现有 X 标志；不引入额外 UI 框架。交互验证优先使用合成 ZIP，并覆盖开发与生产子路径。
- ZIP、模型、真实录制、凭据及带签名 URL 不进入 Git。包内路径及 JSON 均视为数据，不执行其中代码、不自动请求远程资源。
- NPZ、坐标、时间轴和模型裁剪变更须与源结果对照验证，不以默认 FPS、坐标轴或手部均值冒充缺失证据。
- 所有实现、测试及最终 Review 由主 agent 直接完成。
- 本地验证：`npm test`、`npm run lint`、`npm run build`。不增加 CI 或自动发布；部署由用户明确操作。
