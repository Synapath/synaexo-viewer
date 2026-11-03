# SynaExo Viewer

浏览器本地读取 SynaExo ZIP 播放包，显示 SMPL-X 三维人体、EXO／EGO 相机画面和统一时间轴。SMPL-X 在 Web Worker 内按需前向计算，视频通过本地 Blob URL 解码；不需要 Python 服务，不上传 ZIP，也不访问包内记录的远程地址。

支持范围与打包要求见 [ZIP 播放包](PACKAGE.md)。三维人体为不透明白色；干净代理视频上的实时人体叠加为半透明白色。已有叠加视频保留原来的颜色，不重复叠加人体。

## 本地开发

需要 Node.js 20.19+ 或 22.12+。

```sh
npm ci
npm run dev
npm test
npm run lint
npm run build
```

ZIP 首先读取中央目录，随后读取播放所需资源并核对 CRC32、文件大小和清单 SHA-256。关闭、切换和取消会终止计算线程、释放视频 URL 或中断读取。单文件预算为 1 GiB，JSON 为 8 MiB，清单为 20,000 个文件，NPZ 展开预算为 256 MiB；超出范围明确报错。

## GitHub Pages

`npm run build` 输出可直接发布的静态文件到 `docs/`。资源使用相对路径，适配组织项目页及其他静态目录；依赖打进产物，不依赖第三方 CDN。`docs/` 为生成目录，修改源码后重建，不手工编辑。

本仓库不配置自动部署 workflow。你可以在仓库 Settings → Pages 选择 **Deploy from a branch → main → /docs → Save**。默认项目站点为 `https://synapath.github.io/synaexo-viewer/`；是否发布及访问限制由仓库 Pages 设置决定。组织公开仓库也可以使用 Pages，不需要个人仓库或企业版私有站点功能。

发布前运行本地检查并提交源码、锁文件及本次重建的 `docs/`。不要将真实录制、ZIP、模型权重、S3 密钥或带签名的下载地址提交到仓库。

## 品牌与依赖

X 标志沿用 SynaExo 已确认的 SVG，来源为 [Synapath/synaverse](https://github.com/Synapath/synaverse/blob/master/migration_sources/synaexo/frontend/public/brand/exo-4d-mark.svg)。ZIP 读取采用 [zip.js](https://github.com/gildas-lormeau/zip.js)，采用其按条目读取 API；图标使用 Lucide，页面采用 React 和 Vite。构建时从运行依赖生成 `third-party-licenses.txt`，随静态产物分发。

SMPL-X 前向实现参考 [Synapath/smplx-viewer](https://github.com/Synapath/smplx-viewer)，保留其完整姿态修正和线性混合蒙皮，许可见 `licenses/smplx-viewer-MIT.txt`。模型权重不随网站分发。
