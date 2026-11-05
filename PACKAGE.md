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

## 导出索引

两种导出入口都会在 `--output-dir` 下自动生成或更新 `synaexo-index.csv`，列为「录制名称」「录制ID」「run ID」「ZIP文件名」。索引使用 UTF-8 BOM 编码，可直接查看中文；JSON 报告的 `recording_name` 和 `index` 分别返回名称与索引路径。

名称按 `--recording-name`、输入 CSV 的「录制」列、标准录制根清单的 `name` 顺序选取。旧回执可读取 `recording_name`；来源没有名称时该列留空，并在标准错误提示使用 `--recording-name` 补充。

索引在导出成功后累计记录，按 ZIP 相对路径更新，同一 ZIP 重试不重复加行，不同 run 或不同内容的 ZIP 分别保留。单独导出时记录 ZIP 文件名；联合导出时记录 `synaexo-delivery-<内容摘要>/syanexo-<ZIP摘要>.zip`，相对于索引所在目录。索引保存在 ZIP 和联合交付目录之外，不改变它们的内容摘要。

打包失败不增加索引记录。索引更新使用文件锁和原子替换；已有索引格式错误或写入失败时保留原文件，并报告已生成 ZIP 的位置，修复后可重试。

## 联合导出

[`tools/export_delivery.py`](tools/export_delivery.py) 一次导出一个 run 的完整数据包和旁边的可视化 ZIP，交付格式为 `v1.0.0`。三份 Python 文件 `export_delivery.py`、`package_recording.py`、`delivery_bundle.py` 须放在同一目录，依赖仍使用 `tools/requirements-package.txt`。

直接读取标准 S3 **结果清单**（`synaexo_result`，不是录制根清单）：

```sh
/tmp/synaexo-package-venv/bin/python tools/export_delivery.py --manifest s3://BUCKET/PREFIX/NAMESPACE/recordings/RECORDING_ID/results/RUN_ID/manifest.json --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/deliveries
```

脚本校验该 run 引用的 `synaexo_recording` 根清单，读取对应原视频、冻结标定、相机外参、同步与人体结果。只从明确引用读取对象，不扫描整个 bucket 或下载其他 run。原视频按源字节流式下载，可超过浏览器单文件预算，不执行转码、裁剪或算法重跑。

CSV 中若仍是旧 `published.raw_smplx` 回执，联合导出时需补充**同一 run** 的标准结果清单：

```sh
/tmp/synaexo-package-venv/bin/python tools/export_delivery.py --csv /path/to/latest.csv --recording-id FULL_SOURCE_RECORDING_ID --result-manifest s3://BUCKET/PREFIX/NAMESPACE/recordings/RECORDING_ID/results/RUN_ID/manifest.json --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/deliveries
```

两份清单必须匹配来源录制 ID、run、源动作 SHA-256 与质检状态。旧回执只有处理产物时，不能据此找到原片；缺少补充清单就报错，不以烘焙人体的视频替代原片。标准结果清单也可直接放入 CSV 的 `S3清单` 列。`package_recording.py --with-delivery` 与联合入口等价；单独导出可视化时省略该选项，既有旧回执仍可使用。

```text
synaexo-delivery-<内容摘要>/                    # 整套文件路径与摘要生成的目录，与 ZIP 摘要分别计算
├── delivery/                                  # 一个 run 的完整数据交付包
│   ├── README.md                              # 身份、文件用途、读取方法、时间/坐标/单位和限制
│   ├── manifest.json                          # 文件摘要及原片/设备/内外参/同步/人体的对应关系
│   ├── videos/                                # 原始视频，保留源名、字节、素材身份和分段
│   │   ├── gopro/<device_id>/<asset_id>/<source_filename>
│   │   └── ego/<device_id>/<asset_id>/<source_filename>
│   ├── calibration/<calibration_id>/           # 冻结标定，内参对应原视频图像域
│   │   ├── gopro/<device_id>/intrinsics.json    # EXO 内参、畸变与原片分辨率
│   │   └── ego/<device_id>/                    # EGO 单目或左右目参数
│   │       ├── intrinsics.json                 # 左右目 K、畸变、分辨率和布局
│   │       └── extrinsics.json                 # 双目相对 R/t，双目源必须提供
│   ├── trajectories/cameras/<stream_id>/       # 每路相机的世界外参与轨迹
│   │   ├── manifest.json                      # 方向、坐标系、单位、实际时间及静态/动态来源
│   │   └── extrinsics.jsonl                    # 逐帧 R/t 或 T 与有效性，无效值保持 null
│   ├── timeline/                              # 原视频、相机轨迹与人体的同步关系
│   │   ├── reference.json                     # 参考时钟、无损 epoch 与主时间戳数组位置
│   │   ├── clock_models.json                  # 各源时钟到参考时钟的映射
│   │   ├── frame_mapping/<stream_id>.csv       # 段内源帧/PTS、包内原片路径及有效性
│   │   └── quality.json                       # 源同步质量和限制
│   └── motions/subject_01/                    # 同一 run 的人体数据
│       ├── smplx_parameters.npz                # 源动作原字节，含坐标/手部表示/时间声明
│       ├── observations.npz                    # 来源观测与人体有效性
│       └── quality.json                        # 源人体质检，保留原字节
└── syanexo-<ZIP 的完整 SHA-256>.zip             # 同一 run 的独立可视化附件
    ├── README.md                              # 打开步骤、模型身份与源质检
    ├── models/smplx.npz                        # 本次回放所需模型
    ├── motions/subject_01/smplx_parameters.npz  # 动作数组与播放时间/有效性/身份
    └── videos/                                # 既有烘焙人体的视频，原字节复制
        ├── exo01.mp4                           # 实际 EXO 机位按两位序号提供
        └── ego01.mp4                           # 实际存在的 EGO 视角
```

数据清单中的路径均相对于 `delivery/` 根目录。原始视频、人体参数和源质检保持原字节；相机清单的文件引用改为包内路径，帧映射补充 `source_video`。GoPro 多段原片使用来源 `chapters.json` 中的帧边界、SHA-256 和真实 PTS 偏移，将拼接域索引换成段内帧与 PTS；原值保留在 `joined_source_frame_index`、`joined_source_time_ns`。单段原片直接对应；分离式 EGO 双目按现有处理定义以左目同步，保留左右原片与 slot/布局信息。没有分段证据时不猜帧边界。

参考 epoch 以十进制字符串保存，未提供时为 null。人体有效性优先保留源观测文件；仅在来源明确声明全帧有效时允许生成全有效数组，不以固定 FPS 或默认观测补数据。冻结内参、双目相对外参、世界外参、时钟映射、逐帧时间和统计均进行对应校验；缺少必需项时明确指出相机和缺项。

整个数据包与可视化 ZIP 在临时目录校验完成后才发布，失败不留下半套交付。同名内容复用；同名目录被修改时保留原内容并报错，`--force` 不覆盖联合目录。标准输出 JSON 的 `directory`、`delivery`、`archive` 分别指向整套目录、数据包和可视化 ZIP。

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

每个可视化包必须附带回放模型。缺少模型的旧包需用新版打包脚本重新导出；Viewer 直接读取包内模型，不提供单独导入或浏览器模型缓存。

## 校验与分发

包名摘要覆盖整个 ZIP；页面校验 ZIP CRC32、播放数组、模型身份和各路视频的大小及 SHA-256。校验用于发现损坏和错配，不承担来源签名认证，也不代表源结果通过物理精度验收。

真实 ZIP、模型和凭据保持在仓库之外。报告可用于核对单次打包的来源和摘要，不是可视化 ZIP 的必需文件。

页面继续支持自带模型的 `synaexo-viewer-package` 旧清单包及其 `previews/` 视频；新脚本生成本文的 README、models、motions、videos 结构。旧清单包的 `clean_proxy` 分支仍要求视频已去畸变且具备相应标定。源质检字段保留在交付数据中，Viewer 不展示质检状态。
