# 预览 ZIP

预览 ZIP 是单次 run 交付结果旁的可选测试附件。交付结果只导出所选 run 的结果数据，不包含可视化；原始素材、多次结果及处理证据属于平台存储。Viewer 读取预览附件，在浏览器内执行 SMPL-X 前向并同步播放已有叠加的视频。

## 包内结构

```text
syanexo-<ZIP 的完整 SHA-256>.zip
├── motions/
│   └── subject_01/
│       └── smplx_parameters.npz
└── previews/
    ├── exo01.mp4
    ├── exo02.mp4
    └── ego01.mp4
```

一个 ZIP 对应一条录制的一个 run，包含一个人体动作 NPZ 和 1–16 路视频。EXO／EGO 按实际输入生成，文件名为小写两位序号。ZIP 没有根清单，也不携带模型、相机标定、独立时间轴、来源记录或验证目录。

## 打包脚本

[`tools/package_recording.py`](tools/package_recording.py) 的 `build` 从已发布的 S3 回执选取一个结果，校验参数、逐帧时间和有效性，复制已有叠加视频。视频保持原字节，不执行算法或转码。脚本读取的来源证据用于校验，不随预览 ZIP 分发。

打包端需要 Python 3.10+；浏览器播放不需要 Python。在仓库根目录安装依赖：

```sh
python3 -m venv /tmp/synaexo-package-venv
/tmp/synaexo-package-venv/bin/python -m pip install -r tools/requirements-package.txt
```

将示例地址替换为真实值；`--model` 指定计算结果对应、已获许可的完整模型，仅用于验证和绑定摘要：

```sh
/tmp/synaexo-package-venv/bin/python tools/package_recording.py --manifest s3://BUCKET/RESULT/manifest.json --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/attachments
```

也可从 CSV 的 `S3清单` 列选择结果。录制 ID 必须完整且唯一：

```sh
/tmp/synaexo-package-venv/bin/python tools/package_recording.py --csv /path/to/latest.csv --recording-id FULL_RECORDING_ID --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/attachments
```

Boto3 沿用 AWS 凭据链。S3 兼容服务可指定 `--endpoint-url` 和 `--addressing-style`。已有本机对象存储配置时，可传 `--storage-config /path/to/object-storage.json`，读取 `profiles[profile]` 中的 `endpoint`、`region`、`access_key`、`secret_key` 和可选的 `session_token`。显式 endpoint 优先；配置和凭据不会写入 ZIP 或报告。

下载载荷按 SHA-256 校验并缓存，位置由 `--cache-dir` 指定。ZIP 写入临时文件并回读核验后，以 ZIP 字节的完整 SHA-256 命名。相同内容复用已有附件；同名损坏文件需 `--force` 才能替换。标准输出是一份 JSON 报告，下载进度写入标准错误；需要保存报告时重定向标准输出。

```sh
/tmp/synaexo-package-venv/bin/python -m unittest discover -s tools -p 'test_*.py'
```

## 动作 NPZ 与播放信息

原有轴角动作数组保留，包括人体、双手、面部、平移、形状和表情参数，以及 `reference_timestamps_ns`、`coordinate_frame`、`units`、`flat_hand_mean`、`use_pca`。要求米制坐标、完整轴角和 `use_pca: false`，不以默认 FPS、坐标轴或手部均值补齐证据。

打包器在同一个 NPZ 内补充以下数组；解析及维度检查以 [`readPreview`](src/player/preview.ts) 为准：

| 数组 | 含义 |
| --- | --- |
| `model_sha256` | 完整模型文件的 SHA-256 字符串标量 |
| `body_observed` | `[N]` 人体逐帧有效性 |
| `preview_metadata` | JSON 字符串标量，记录格式、录制和结果 ID、源质检状态、模型维数，以及各路视频的身份、类型、分辨率、大小和摘要 |
| `preview_video_pts_ns` | `[V,N]` 各路 MP4 的相对纳秒 PTS |
| `preview_source_observed` | `[V,N]` 各路视频逐帧来源有效性 |

主时间轴和视频 PTS 必须精确、严格递增，并在解析器允许的容器时间基误差内一致。人体部分缺失时需要逐帧 mask；仅在来源明确声明全帧有效时才能由总数生成全有效 mask。缺失观测不会当作有效数据，源 `physical_accuracy_passed` 状态保持不变。

新包的视频均已烘焙人体，直接显示原画面，不重复投影。三维人体在 Worker 中由动作参数生成，不需要相机标定。

## 模型与浏览器缓存

首次打开新预览包时，点击「选择模型」导入打包时对应的完整 SMPL-X 模型 NPZ。Viewer 校验完整文件 SHA-256，将模型保存在当前站点的 IndexedDB，并自动继续打开 ZIP。之后同一浏览器、同一站点的其他匹配预览包复用模型缓存。清除站点数据或切换站点后需要重新导入。

模型由使用者按适用许可获取，不随预览 ZIP、仓库或 GitHub Pages 分发。普通 SMPL-X 模型许可不等于允许公开再分发，参见 [SMPL-X 模型许可](https://smpl-x.is.tue.mpg.de/modellicense.html)。缓存失败、模型不匹配时页面保留错误提示，可重新选择。

## 校验与分发

包名摘要覆盖整个 ZIP；页面校验 ZIP CRC32、播放数组、模型身份和各路视频的大小及 SHA-256。校验用于发现损坏和错配，不承担来源签名认证，也不代表源结果通过物理精度验收。

真实 ZIP、模型和凭据保持在仓库之外。报告可用于核对单次打包的来源和摘要，不是预览 ZIP 的必需文件。

页面继续支持已发布的 `synaexo-viewer-package` 旧包，包括包内模型和旧清单；新脚本仅生成本文的双目录结构。旧包的 `clean_proxy` 分支仍要求视频已去畸变且具备相应标定。
