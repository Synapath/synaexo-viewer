# 打包工具

导出一条录制的一个 run，可选择完整数据交付包加可视化 ZIP，或只导出可视化 ZIP。

| 文件 | 用途 |
| --- | --- |
| [export_delivery.py](export_delivery.py) | 交付＋预览：导出数据目录和同一 run 的可视化 ZIP |
| [package_recording.py](package_recording.py) | 仅预览：导出可直接拖入 Viewer 的可视化 ZIP |
| [delivery_bundle.py](delivery_bundle.py) | 联合导出使用的配套模块，与两个入口放在同一目录 |
| [requirements-package.txt](requirements-package.txt) | 打包端 Python 依赖清单 |

## 安装

需要 Python 3.10+、可读取来源对象的 S3 配置，以及与动作参数匹配的完整 SMPL-X 模型 NPZ。浏览器查看 ZIP 不需要 Python。

以下命令在本目录（`tools/`）执行；示例中的 S3 地址、模型路径、录制 ID 和输出路径须替换为实际值。

```sh
python3 -m venv /tmp/synaexo-package-venv
/tmp/synaexo-package-venv/bin/python -m pip install -r requirements-package.txt
```

S3 沿用 Boto3 的 AWS 凭据链；兼容服务的 endpoint 和配置文件用法见 [S3 配置说明](../PACKAGE.md#打包脚本)。

## 交付＋预览

`--manifest` 指向所选 run 的标准 `synaexo_result` 结果清单：

```sh
/tmp/synaexo-package-venv/bin/python export_delivery.py --manifest s3://BUCKET/PREFIX/recordings/RECORDING_ID/results/RUN_ID/manifest.json --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/exports
```

输出包含原始视频、内外参、相机轨迹、同步和人体结果的数据交付目录，以及旁边的可视化 ZIP。输出结构与输入要求见 [联合导出](../PACKAGE.md#联合导出)。

## 仅预览

```sh
/tmp/synaexo-package-venv/bin/python package_recording.py --manifest s3://BUCKET/PREFIX/recordings/RECORDING_ID/results/RUN_ID/manifest.json --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/exports
```

将导出的 `syanexo-<完整SHA-256>.zip` 拖入 [SynaExo Viewer](https://synapath.github.io/synaexo-viewer/) 即可查看。包内自带回放模型、动作参数和同步视频。

## 从 CSV 选择录制

```sh
/tmp/synaexo-package-venv/bin/python package_recording.py --csv /path/to/latest.csv --recording-id FULL_RECORDING_ID --model /path/to/SMPLX_NEUTRAL.npz --output-dir /path/to/exports
```

录制 ID 必须完整且唯一。联合导出也支持 CSV；若 CSV 指向旧回执，需额外提供同一 run 的 `--result-manifest`，完整命令见 [联合导出](../PACKAGE.md#联合导出)。

## 查找导出的 ZIP

在 `--output-dir` 指定的目录查看自动生成的 `synaexo-index.csv`，按录制名称、录制 ID 或 run ID 查找 ZIP。名称缺失时，可在导出命令中加 `--recording-name "录制名称"`。

索引字段、名称来源和累计规则见 [导出索引](../PACKAGE.md#导出索引)。标准输出的 JSON 报告也会返回 ZIP 和索引路径。

## 查看参数

```sh
/tmp/synaexo-package-venv/bin/python export_delivery.py --help
/tmp/synaexo-package-venv/bin/python package_recording.py --help
```

完整的模型、时间轴、数据校验和可视化包格式约定见 [可视化包说明](../PACKAGE.md)。
