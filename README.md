# SynaExo Viewer

浏览器本地读取 SynaExo ZIP 录制包的静态页面。支持文件清单、JSON、图片及浏览器可解码的视频；不会上传 ZIP，也不请求清单中指向的远程地址。

NPZ／NPY／ONNX 文件只登记为参数资源。浏览器内 SMPL-X 前向、逐帧同步与三维叠加尚未接入；Python／PyTorch 服务不能在 GitHub Pages 上运行。[ZIP 样包结构](PACKAGE.md)记录打包范围和时间、模型证据，页面按文件读取，不将文件存在视为算法质检通过。

## 本地开发

需要 Node.js 20.19+ 或 22.12+。

```sh
npm ci
npm run dev
npm test
npm run lint
npm run build
```

ZIP 首先读取中央目录，选择文件时才解压。关闭、切换和取消会释放当前引用或中断读取，视频使用本地 Blob URL。单文件预览预算为 1 GiB，JSON 为 8 MiB，清单为 20,000 个文件；超过预算明确报错，不伪装成空包。参数文件不在浏览器中自动执行。ZIP CRC32 只检测包内损坏，不代替来源 manifest 的 SHA-256 回执核验。

## GitHub Pages

`npm run build` 输出可直接发布的静态文件到 `docs/`。资源使用相对路径，适配组织项目页及其他静态目录；依赖打进产物，不依赖第三方 CDN。`docs/` 为生成目录，修改源码后重建，不手工编辑。

本仓库不配置自动部署 workflow。你可以在仓库 Settings → Pages 选择 **Deploy from a branch → main → /docs → Save**。默认项目站点为 `https://synapath.github.io/synaexo-viewer/`；是否发布及访问限制由仓库 Pages 设置决定。组织公开仓库也可以使用 Pages，不需要个人仓库或企业版私有站点功能。

发布前运行本地检查并提交源码、锁文件及本次重建的 `docs/`。不要将真实录制、ZIP、模型权重、S3 密钥或带签名的下载地址提交到仓库。

## 品牌与依赖

X 标志沿用 SynaExo 已确认的 SVG，来源为 [Synapath/synaverse](https://github.com/Synapath/synaverse/blob/master/migration_sources/synaexo/frontend/public/brand/exo-4d-mark.svg)。ZIP 读取采用 [zip.js](https://github.com/gildas-lormeau/zip.js)，采用其按条目读取 API；图标使用 Lucide，页面采用 React 和 Vite。构建时从运行依赖生成 `third-party-licenses.txt`，随静态产物分发。
