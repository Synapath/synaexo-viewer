# ZIP 样包

打包器将一条结果整理为本地 ZIP，静态页面通过 `src/lib/archive.ts` 的 `openArchive` 读取。页面支持普通 ZIP 资源浏览；本页定义样包约定，不表示页面已执行 SMPL-X 前向或同步叠加。

```text
manifest.json
motions/subject_01/smplx_parameters.npz
models/SMPLX_NEUTRAL_B10_E10.npz
timeline/
  reference.json
  source_frames/<view_id>.npz
calibration/cameras.json
previews/<view_id>.mp4
provenance/
  source-manifest.json
  layer.json
  preprocessing.json
  quality.json
validation/
  model-trim-report.json
  model-trim-validation.json
  source-parameter-mesh-check.json
```

原结果中不存在的数据不补默认值。`view_id` 使用 `exo01`、`exo02` 等外部机位名，以及 `ego01` 第一人称机位名；`camera_id` 保留源身份，显示顺序与文件名的对应关系保存在 `calibration/cameras.json`。

## 清单与来源

根清单的 `format` 为 `synaexo-viewer-package`。`format_version` 标记样包结构；`recording_id`、`result_id` 和 `display_name` 标识来源录制与结果。`files` 为除根清单自身之外的载荷清单，每条包含 `path`、`role`、`bytes`、`sha256`；原文件条目还保留源对象键与原始 SHA-256。

根清单引用动作参数、模型、相机证据和主时间轴，保存坐标系名称、单位及源质检结果。源清单和原处理记录放入 `provenance/`，其中历史路径仅作为证据，不要求 ZIP 将这些路径对应的所有网格、诊断输出或 RRD 一起携带。来源可回读及包内校验通过，不会将 `physical_accuracy_passed` 从失败改为通过。

原始视频、逐帧网格和诊断中间产物不属于此样包的必需载荷。`previews/` 可以使用已有的叠加视频，但须标记 `video_content: existing_baked_projections`，相机条目标记 `content: baked_projection`；这种视频不等同于干净代理，不能再叠加一次人体。

## 时间与模型

`timeline/reference.json` 保留严格递增的相对纳秒时间数组。源时间原点和 Unix epoch 用十进制字符串保存，避免 JavaScript `Number` 对大整数截断；相对时间须处于安全整数范围。相机视频 PTS 和原始帧对应证据保留，不以默认 FPS 重建时间轴。

`parameters.representation` 明确动作参数表示法，`flat_hand_mean`、`use_pca` 取自源结果。模型条目保存源模型 SHA-256、形状和表情维数，以及表情方向在基底中的起始索引。模型裁剪只适用于清单声明的参数范围，保留姿态修正、蒙皮权重和关节回归；不得将有限维数的回放模型当作完整原模型的通用替代品。

`validation/` 中的报告明确抽查帧和误差范围。模型等价抽查不能替代动作重建或相机对齐的物理精度验收。

## 校验与分发

打包前核对源回执的文件大小和 SHA-256，打包后重新读取载荷，核对根清单的大小和 SHA-256，并检查 ZIP CRC32。静态页面的文件读取检查 CRC32，不承担来源签名或源回执认证。

真实 ZIP、模型和凭据保持在仓库之外。分发包含模型的录制包时，沿用该模型适用的许可范围；不通过 GitHub Pages 发布模型文件。
