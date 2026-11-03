<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="SynaExo Logo" />
</p>

<h1 align="center">SynaExo Viewer</h1>

<p align="center">SMPL-X 三维人体与 EXO／EGO 多视角视频的本地同步回放</p>

<p align="center">
  <a href="https://github.com/Synapath/synaexo-viewer/actions/workflows/pages.yml"><img src="https://github.com/Synapath/synaexo-viewer/actions/workflows/pages.yml/badge.svg" alt="检查与发布" /></a>
  <br />
  <img src="https://img.shields.io/badge/React-20232a?logo=react&amp;logoColor=61dafb" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Three.js-222222?logo=threedotjs&amp;logoColor=white" alt="Three.js" />
  <img src="https://img.shields.io/badge/Vite-646cff?logo=vite&amp;logoColor=white" alt="Vite" />
</p>

<p align="center">
  <a href="https://synapath.github.io/synaexo-viewer/">打开 Viewer</a> ·
  <a href="PACKAGE.md">ZIP 打包与格式</a> ·
  <a href="https://github.com/Synapath/synaverse/blob/master/migration_sources/synaexo/README.md">SynaExo 工作台</a>
</p>

SynaExo Viewer 是独立的静态回放页面。拖入一个 ZIP 录制包，即可在等尺寸宫格中查看 SMPL-X 人体与 EXO／EGO 视频，通过统一时间轴播放、暂停和跳转。

参数解析、SMPL-X 前向计算和视频解码均在浏览器本地完成，前向计算运行于 Web Worker。播放无需 Python 服务或 S3 凭据；页面不上传录制包，也不请求包内记录的远程地址。

## 打开录制包

1. 打开 [Viewer](https://synapath.github.io/synaexo-viewer/)。
2. 拖入按 [ZIP 播放包约定](PACKAGE.md)准备的文件，或点击「打开 ZIP」。
3. 页面自动读取包内模型和动作参数，无需另行导入模型。
4. 使用底部时间轴控制同步回放，在三维视图中拖动旋转、滚轮缩放。

三维人体显示为不透明白色，EXO／EGO 视频保留已烘焙的原画面。可视化 ZIP 包含 `README.md`、`models/`、`motions/` 和 `videos/`，格式和时间要求见 [可视化包](PACKAGE.md)。

需要从 SynaExo 已发布的 S3 结果准备录制包时，使用 [打包脚本](PACKAGE.md#打包脚本)。Python 和对象存储凭据仅在打包端准备；包内已附本次回放所需的模型。

## 本地开发

以下命令在仓库根目录执行，Node.js 使用 [Pages 工作流](.github/workflows/pages.yml)中配置的版本。

```sh
npm ci
npm run dev
```

提交前检查：

```sh
npm test
npm run lint
npm run build
```

打包脚本的依赖与测试命令见 [打包说明](PACKAGE.md#打包脚本)。

### 源码入口

| 路径 | 内容 |
| --- | --- |
| [`src/App.tsx`](src/App.tsx) | 录制包导入、切换与关闭 |
| [`src/player`](src/player) | 三维场景、多视角布局、同步播放与计算 Worker |
| [`src/smplx`](src/smplx) | SMPL-X 前向与 NPY／NPZ 解析 |
| [`src/lib/archive.ts`](src/lib/archive.ts) | ZIP 按条目读取与 CRC 校验 |
| [`tools/package_recording.py`](tools/package_recording.py) | 从已发布结果生成录制包 |
| [`public`](public) | 品牌资源与依赖许可清单 |
| [`docs`](docs) | 静态构建产物 |

## GitHub Pages

推送 `main` 后，[Pages 工作流](.github/workflows/pages.yml)执行打包脚本测试、前端测试、lint 和构建，全部通过后自动发布。运行结果与部署记录见 [GitHub Actions](https://github.com/Synapath/synaexo-viewer/actions/workflows/pages.yml)。仓库 Settings → Pages 的发布来源使用 **GitHub Actions**。

`npm run build` 将静态文件输出到 `docs/`，资源使用相对路径，依赖随构建产物分发，可部署到项目子路径。`docs/` 为生成目录，修改源码后重建并随源码提交，不手工编辑生成文件。

## 数据与许可

录制包内的路径与 JSON 仅作为数据读取。播放载荷会核对 CRC32、文件大小和清单 SHA-256；关闭、切换或取消导入时释放相应资源。包内校验通过不代表源结果通过物理精度验收，来源状态保持不变，详见 [校验与分发](PACKAGE.md#校验与分发)。

真实录制、ZIP、模型权重、凭据和带签名的下载地址不提交到仓库。打包者须按模型适用许可在获授权范围内分发含模型的 ZIP；模型权重不随网站发布。

X 标志沿用 [SynaExo 品牌资源](https://github.com/Synapath/synaverse/blob/master/migration_sources/synaexo/frontend/public/brand/exo-4d-mark.svg)。SMPL-X 前向实现参考 [Synapath/smplx-viewer](https://github.com/Synapath/smplx-viewer)，保留完整姿态修正和线性混合蒙皮，许可见 [smplx-viewer MIT](licenses/smplx-viewer-MIT.txt)。

上述来源仓库需相应访问权限。

依赖以 [package-lock.json](package-lock.json) 为准。构建时由 [`tools/write-licenses.mjs`](tools/write-licenses.mjs)生成 [第三方许可清单](docs/third-party-licenses.txt)，随静态产物分发。
