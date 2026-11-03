# 可视化包

可视化 ZIP 是单次 run 交付结果旁的可选测试附件。交付结果只导出所选 run 的结果数据，不包含可视化；原始素材、多次结果及处理证据属于平台存储。Viewer 读取可视化包，在浏览器内执行 SMPL-X 前向并同步播放已有叠加的视频。

## 包内结构

```text
syanexo-<ZIP 的完整 SHA-256>.zip
├── README.md
├── models/
│   └── smplx.npz
├── motions/
│   └── subject_01/
│       └── smplx_parameters.npz
└── videos/
    ├── exo01.mp4
    ├── exo02.mp4
    └── ego01.mp4
```

一个 ZIP 对应一条录制的一个 run，包含 README、一个回放模型、一个人体动作 NPZ 和 1–16 路视频。EXO／EGO 按实际输入生成，文件名为小写两位序号。ZIP 根目录附带 README，说明录制与 run 身份、文件用途、使用步骤、模型摘要和源质检状态。ZIP 自带 `models/smplx.npz`，不携带独立相机标定、时间轴、来源记录或验证目录，也没有根 manifest。

## 打包脚本

[`tools/package_recording.py`](tools/package_recording.py) 的 `build` 从已发布的 S3 回执选取一个结果，校验参数、逐帧时间和有效性，复制已有叠加视频。视频保持原字节，不执行算法或转码。脚本读取的来源证据用于校验，不随可视化 ZIP 分发。

打包端需要 Python 3.10+；浏览器播放不需要 Python。在仓库根目录安装依赖：

```sh
python3 -m venv /tmp/synaexo-package-venv
/tmp/synaexo-package-venv/bin/python -m pip install -r tools/requirements-package.txt
```

将示例地址替换为真实值；`--model` 指定计算结果对应、已获许可的完整模型，用于验证并生成包内回放模型：

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
| `model_sha256` | 包内 `models/smplx.npz` 的 SHA-256 字符串标量 |
| `source_model_sha256` | 打包输入的完整模型文件 SHA-256 |
| `body_observed` | `[N]` 人体逐帧有效性 |
| `preview_metadata` | JSON 字符串标量，记录格式、录制和结果 ID、源质检状态、模型维数，以及各路视频的身份、类型、分辨率、大小和摘要 |
| `preview_video_pts_ns` | `[V,N]` 各路 MP4 的相对纳秒 PTS |
| `preview_source_observed` | `[V,N]` 各路视频逐帧来源有效性 |

主时间轴和视频 PTS 必须精确、严格递增，并在解析器允许的容器时间基误差内一致。人体部分缺失时需要逐帧 mask；仅在来源明确声明全帧有效时才能由总数生成全有效 mask。缺失观测不会当作有效数据，源 `physical_accuracy_passed` 状态保持不变。

包内视频均已烘焙人体，直接显示原画面，不重复投影。三维人体在 Worker 中由动作参数生成，不需要相机标定。

## 包内模型

Viewer 自动读取 `models/smplx.npz`，无需再选择模型。打包器保留本次动作使用的体型和表情基底，以及完整的姿态修正、关节回归、蒙皮和所需手部均值；表情基底仍从索引 300 开始。源模型摘要与实际包内模型摘要分别保存，并在读取时核对包内模型的大小和 SHA-256。

该模型仅用于本包声明的参数维数，不作为通用完整模型。模型和录制按适用许可在获授权的范围内分发；真实 ZIP 和模型权重不提交到公开仓库或 GitHub Pages，参见 [SMPL-X 模型许可](https://smpl-x.is.tue.mpg.de/modellicense.html)。

已发布的无模型旧包仍支持独立导入模型并复用 IndexedDB 缓存。缓存按同一浏览器、同一站点的模型摘要区分，不是新包打开的前置条件。

## 校验与分发

包名摘要覆盖整个 ZIP；页面校验 ZIP CRC32、播放数组、模型身份和各路视频的大小及 SHA-256。校验用于发现损坏和错配，不承担来源签名认证，也不代表源结果通过物理精度验收。

真实 ZIP、模型和凭据保持在仓库之外。报告可用于核对单次打包的来源和摘要，不是可视化 ZIP 的必需文件。

页面继续支持已发布的 `synaexo-viewer-package` 旧包，包括包内模型和旧清单；新脚本生成本文的 README、models、motions、videos 结构。已发布的双目录旧包继续读取其 `previews/` 视频，不重命名历史文件。旧包的 `clean_proxy` 分支仍要求视频已去畸变且具备相应标定。
