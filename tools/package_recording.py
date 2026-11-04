#!/usr/bin/env python3
"""Build a local Viewer ZIP from a published S3 receipt."""
import argparse
import csv
import hashlib
import math
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tempfile
from urllib.parse import urlparse
import zipfile

import numpy as np
from botocore.exceptions import BotoCoreError, ClientError

JSON_LIMIT = 8 * 1024 ** 2
FILE_LIMIT = 1024 ** 3
SAFE_INTEGER = 2 ** 53 - 1


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(value):
    require(isinstance(value, str) and value and not value.startswith('/')
            and '\\' not in value and ':' not in value
            and not any(ord(c) < 32 for c in value)
            and all(p not in ('', '.', '..') for p in value.split('/')),
            f'路径无效：{value}')
    return value


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 ** 2), b''):
            h.update(block)
    return h.hexdigest()


def select_source(csv_path, recording_id):
    with Path(csv_path).open(encoding='utf-8-sig', newline='') as stream:
        rows = [r for r in csv.DictReader(stream) if r.get('recording_id') == recording_id]
    require(len(rows) == 1, f'CSV 中录制 ID 必须唯一匹配：{recording_id}')
    return rows[0]['S3清单'], rows[0].get('录制', recording_id)


def storage_client(args):
    import boto3
    from botocore.config import Config
    options = {}
    endpoint = args.endpoint_url
    if args.storage_config:
        settings = json.loads(args.storage_config.read_text(encoding='utf-8'))
        profile = settings['profiles'][settings['profile']]
        options = {'region_name': profile['region'], 'aws_access_key_id': profile['access_key'],
                   'aws_secret_access_key': profile['secret_key']}
        if profile.get('session_token'):
            options['aws_session_token'] = profile['session_token']
        endpoint = endpoint or profile['endpoint']
    return boto3.client('s3', endpoint_url=endpoint, config=Config(
        signature_version='s3v4', s3={'addressing_style': args.addressing_style},
        connect_timeout=10, read_timeout=60, retries={'max_attempts': 2}), **options)


def timestamps(values, frames, label):
    a = np.asarray(values)
    require(a.shape == (frames,) and a.dtype.kind in 'iu'
            and all(0 <= int(t) <= SAFE_INTEGER for t in a)
            and all(int(a[i]) > int(a[i - 1]) for i in range(1, frames)),
            f'{label} 必须包含逐帧、严格递增的精确纳秒时间')
    return [int(t) for t in a]


class Receipt:
    def __init__(self, client, uri, cache, expected_recording_id=None):
        parsed = urlparse(uri)
        require(parsed.scheme == 's3' and parsed.netloc and not parsed.query
                and not parsed.fragment, 'manifest 必须是 s3://bucket/key 地址')
        self.client, self.bucket = client, parsed.netloc
        key = safe_path(parsed.path.lstrip('/'))
        parent = key.rpartition('/')[0]
        self.prefix = parent + '/' if parent else ''
        response = client.get_object(Bucket=self.bucket, Key=key)
        try:
            self.raw = response['Body'].read(JSON_LIMIT + 1)
        finally:
            response['Body'].close()
        require(len(self.raw) <= JSON_LIMIT, 'manifest 超过 JSON 解析预算')
        self.manifest = json.loads(self.raw)
        self.document = self.manifest
        self.standard = self.document.get('format') == 'synaexo_result'
        self.result_prefix = None
        if self.standard:
            result_id = safe_path(self.document['result_id'])
            require('/' not in result_id and self.document.get('schema_version') == 1,
                    '标准结果身份或版本无效')
            suffix = f'results/{result_id}/manifest.json'
            require(key.endswith(suffix) and (key == suffix or key[-len(suffix)-1] == '/'),
                    '标准结果地址与 run ID 不一致')
            self.prefix = key[:-len(suffix)]
            self.result_prefix = f'results/{result_id}/'
        if expected_recording_id is not None:
            require(expected_recording_id in {self.manifest['recording_id'], self.manifest.get('source_recording_id')},
                    'CSV 中的录制 ID 与 S3 manifest 不一致')
        self.files = {}
        for item in self.manifest['files']:
            if self.standard:
                path = safe_path(item['path'])
                require(path.startswith((self.result_prefix, f'previews/{result_id}/')),
                        '标准结果清单包含其他 run 的文件')
                item = {'source_path': path, 'object_key': self.prefix + path,
                        'bytes': item['size_bytes'], 'sha256': item['sha256']}
            path = safe_path(item['source_path'])
            object_key = safe_path(item['object_key'])
            require(path not in self.files and object_key.startswith(self.prefix)
                    and type(item['bytes']) is int and item['bytes'] >= 0
                    and isinstance(item['sha256'], str) and len(item['sha256']) == 64
                    and all(c in '0123456789abcdef' for c in item['sha256']),
                    f'manifest 文件条目无效：{path}')
            self.files[path] = item
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        if self.standard:
            layers = [p for p in self.files if p.startswith(self.result_prefix + 'motions/humans/')
                      and p.endswith('/manifest.json')]
            require(len(layers) == 1, '可视化需要唯一的人体结果清单')
            self.manifest = {**self.document, 'published': {
                'state': 'succeeded', 'raw_smplx': layers[0], 'version': result_id}}

    def register(self, item):
        path = safe_path(item['path'])
        size, sha = item['size_bytes'], item['sha256']
        require(type(size) is int and size >= 0 and isinstance(sha, str) and len(sha) == 64
                and all(c in '0123456789abcdef' for c in sha), f'标准文件条目无效：{path}')
        row = {'source_path': path, 'object_key': self.prefix + path, 'bytes': size, 'sha256': sha}
        require(path not in self.files or self.files[path] == row, f'标准清单文件冲突：{path}')
        self.files[path] = row
        return path

    def named(self, name):
        matches = [p for p in self.files if PurePosixPath(p).name == name]
        require(len(matches) == 1, f'回执中找不到唯一文件：{name}')
        return matches[0]

    def get(self, source_path, limit=FILE_LIMIT):
        item = self.files[source_path]
        require(limit is None or item['bytes'] <= limit, f'文件超过解析预算：{source_path}')
        target = self.cache / item['sha256']
        if (target.is_file() and target.stat().st_size == item['bytes']
                and digest(target) == item['sha256']):
            return target
        fd, temp = tempfile.mkstemp(dir=self.cache, suffix='.part')
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=item['object_key'])
            try:
                with os.fdopen(fd, 'wb') as stream:
                    fd = None
                    size = 0
                    for block in response['Body'].iter_chunks(chunk_size=1024 ** 2):
                        size += len(block)
                        require(size <= item['bytes'], f'文件超出回执大小：{source_path}')
                        stream.write(block)
            finally:
                response['Body'].close()
            require(Path(temp).stat().st_size == item['bytes']
                    and digest(temp) == item['sha256'], f'文件摘要不匹配：{source_path}')
            os.replace(temp, target)
            print(f'package_recording: 已校验：{source_path}', file=sys.stderr, flush=True)
            return target
        finally:
            if fd is not None:
                os.close(fd)
            Path(temp).unlink(missing_ok=True)

    def json(self, path):
        require(self.files[path]['bytes'] <= JSON_LIMIT, f'JSON 超出解析预算：{path}')
        return json.loads(self.get(path).read_bytes())


def validate_npz_budget(path, keys=None):
    """Check NPY allocations before NumPy materializes trusted-source payloads."""
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        require(len(entries) <= 256 and len({e.filename for e in entries}) == len(entries), 'NPZ 数组数量或名称无效')
        total = 0
        for entry in entries:
            require(re.fullmatch(r'[-\w]+\.npy', entry.filename) is not None and not entry.flag_bits & 1, 'NPZ 数组路径无效')
            if keys is not None and entry.filename[:-4] not in keys:
                continue
            total += entry.file_size
            require(total <= 256 * 1024**2, 'NPZ 展开内容超过浏览器预算')
            with archive.open(entry) as stream:
                version = np.lib.format.read_magic(stream)
                reader = {(1, 0): np.lib.format.read_array_header_1_0, (2, 0): np.lib.format.read_array_header_2_0}.get(version)
                require(reader is not None, 'NPY 版本不支持')
                shape, _, dtype = reader(stream, max_header_size=65536)
                require(not dtype.hasobject and math.prod(shape) * dtype.itemsize == entry.file_size - stream.tell(),
                        'NPY 分配大小与实际内容不一致')


def validate_model(source, betas, expressions, flat_hand_mean):
    required = {'v_template': (10475, 3), 'posedirs': (10475, 3, 486),
                'J_regressor': (55, 10475), 'weights': (10475, 55), 'kintree_table': (2, 55)}
    validate_npz_budget(source, set(required) | {'shapedirs', 'f', 'hands_meanl', 'hands_meanr'})
    with np.load(source, allow_pickle=False) as model:
        for key, shape in required.items():
            value = model[key]
            require(value.shape == shape and np.isfinite(value).all(), f'模型数组维度或数值无效：{key}')
        shape = model['shapedirs']
        require(shape.ndim == 3 and shape.shape[:2] == (10475, 3)
                and shape.shape[2] >= (max(betas, 300 + expressions) if expressions else betas)
                and np.isfinite(shape).all(), '模型形状或表情基底不足')
        faces = model['f']
        require(faces.ndim == 2 and faces.shape[1] == 3 and faces.dtype.kind in 'iu'
                and faces.size > 0 and faces.min() >= 0 and faces.max() < 10475, '模型三角面无效')
        parents = model['kintree_table'][0]
        require((parents[0] < 0 or parents[0] >= 55)
                and all(0 <= parents[i] < i for i in range(1, 55)), '模型关节层级无效')
        if not flat_hand_mean:
            for key in ['hands_meanl', 'hands_meanr']:
                require(model[key].shape == (45,) and np.isfinite(model[key]).all(), f'模型平均手势无效：{key}')
    return digest(source)


def write_playback_model(source, destination, betas, expressions, flat_hand_mean):
    keys = ['v_template', 'posedirs', 'J_regressor', 'weights', 'kintree_table', 'f']
    if not flat_hand_mean:
        keys += ['hands_meanl', 'hands_meanr']
    with np.load(source, allow_pickle=False) as model:
        arrays = {key: model[key] for key in keys}
        # Keep the active bases and the fixed expression offset used by SMPL-X.
        compact = np.zeros((10475, 3, 300 + expressions), dtype=np.float32)
        compact[:, :, :betas] = model['shapedirs'][:, :, :betas]
        compact[:, :, 300:] = model['shapedirs'][:, :, 300:300 + expressions]
        arrays['shapedirs'] = compact
    np.savez_compressed(destination, **{k: np.asfortranarray(v) for k, v in arrays.items()})
    return digest(destination)


def visualization_readme(metadata, frames, duration_ns, world_frame):
    matrix = metadata.get('representation') == 'smplx_local_rotations'
    video_note = ('视频未烘焙 SMPL-X；Viewer 使用包内相机投影实时叠加。原画面中的真人保留。' if matrix
                  else '视频中的 SMPL-X 人体已烘焙进 MP4，独立三维人体材质不会改变视频画面。')
    model_note = ('包内模型与平台播放模型字节一致，保留源模型摘要；前向直接使用最终旋转矩阵。' if matrix
                  else '包内模型仅保留本次动作使用的形状／表情基底，以及姿态修正、关节回归和蒙皮数据，不是通用完整模型。')
    videos = '\n'.join(f'    ├── {v["view_id"].lower()}.mp4  ({v["kind"]})' for v in metadata['videos'])
    quality = '通过' if metadata['physical_accuracy_passed'] else '未通过'
    return f'''# SynaExo 可视化包

本包用于本地查看一个 run 的 SMPL-X 人体和同步 EXO／EGO 视频。

- 录制 ID：`{metadata['recording_id']}`
- run ID：`{metadata['result_id']}`
- 帧数：{frames}；时间跨度：{duration_ns / 1e9:.6f} 秒
- 坐标系：`{world_frame}`；单位：米
- 源物理精度检查：{quality}。文件校验和播放成功不代表物理精度通过。

## 文件

```text
README.md
models/smplx.npz
motions/subject_01/smplx_parameters.npz
videos/
{videos}
```

## 打开

1. 打开 https://synapath.github.io/synaexo-viewer/ 。
2. 拖入整个 ZIP，或点击「打开 ZIP」。包内已带模型，无需另行导入。
3. 使用底部时间轴播放、暂停和跳转；三维视图可拖动旋转、滚轮缩放。

网页在浏览器本地读取，不上传文件，不需要 Python 或 S3 凭据。
{video_note}
动作 NPZ 保存时间戳、逐帧有效性和视频校验信息，不以默认 FPS 补齐数据。

## 模型与校验

- 模型维数：{metadata['model']['num_betas']} 维体型、{metadata['model']['num_expression']} 维表情。
- 包内模型 SHA-256：`{metadata['model']['sha256']}`
- 原模型 SHA-256：`{metadata['model']['source_sha256']}`
- {model_note}
- ZIP 的 SHA-256 见文件名；该摘要覆盖 README 和全部载荷。

模型和录制仅按各自适用的许可范围分发，不将权重发布到公开仓库或 GitHub Pages。
'''


class Package:
    def __init__(self):
        self.items = {}
        self.files = []

    def add(self, path, local, role, original=None):
        safe_path(path)
        require(path not in self.items and path != 'manifest.json', f'包内路径重复：{path}')
        size, sha = local.stat().st_size, digest(local)
        require(size <= FILE_LIMIT, f'文件超过 Viewer 预算：{path}')
        if original:
            require(size == original['bytes'] and sha == original['sha256'], f'载荷与回执不符：{path}')
        row = {'path': path, 'role': role, 'bytes': size, 'sha256': sha}
        if original:
            row['source'] = {k: original[k] for k in ['source_path', 'object_key', 'sha256']}
        self.items[path] = local
        self.files.append(row)

    def write(self, output, force=False):
        require(force or not output.exists(), f'输出已存在：{output}；覆盖请使用 --force')
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=output.parent, suffix='.zip.part')
        os.close(fd)
        try:
            with zipfile.ZipFile(name, 'w', allowZip64=True) as archive:
                for path, local in self.items.items():
                    # Stable metadata makes identical payloads produce the same attachment name.
                    info = zipfile.ZipInfo(path)
                    info.file_size = local.stat().st_size
                    with local.open('rb') as source, archive.open(info, 'w', force_zip64=True) as target:
                        shutil.copyfileobj(source, target, 1024 ** 2)
            with zipfile.ZipFile(name) as archive:
                for item in self.files:
                    h = hashlib.sha256()
                    with archive.open(item['path']) as stream:
                        for block in iter(lambda: stream.read(1024 ** 2), b''):
                            h.update(block)
                    require(archive.getinfo(item['path']).file_size == item['bytes']
                            and h.hexdigest() == item['sha256'], f'ZIP 回读校验失败：{item["path"]}')
            os.replace(name, output)
        finally:
            Path(name).unlink(missing_ok=True)


def build(args, receipt, temp):
    source = receipt.manifest
    published = source['published']
    require(published['state'] in {'succeeded', 'partial'}, '来源结果未发布，请检查 manifest')
    layer = receipt.json(published['raw_smplx'])
    require(layer['recording_id'] == source['recording_id']
            and layer['units'] == 'm' and isinstance(layer['world_frame'], str)
            and layer['world_frame'] and type(layer['physical_accuracy_passed']) is bool,
            '结果身份、坐标系、单位或质检状态无效')
    matrix = layer.get('delivery_profile') == 'parameters'
    frames = layer['frames']
    require(type(frames) is int and frames > 0, '人体结果帧数无效')
    parameters_path = receipt.get(layer['parameters'], limit=128 * 1024**2)
    validate_npz_budget(parameters_path)
    with np.load(parameters_path, allow_pickle=False) as saved:
        motion = {k: saved[k].copy() for k in saved.files}
    ts = motion['reference_timestamps_ns']
    require(ts.dtype.kind in 'iu' and ts.shape == (frames,), '参数缺少精确逐帧时间')
    origin = int(ts[0])
    times = timestamps([int(t) - origin for t in ts], frames, '主时间轴')
    require(str(motion['coordinate_frame'].item()) == layer['world_frame']
            and str(motion['units'].item()) == 'm', '参数坐标系与结果不一致')
    require(motion['flat_hand_mean'].dtype.kind == 'b' and motion['use_pca'].dtype.kind == 'b', '参数必须声明手部表示')
    flat, pca = bool(motion['flat_hand_mean'].item()), bool(motion['use_pca'].item())
    require(not pca, 'Viewer 不支持 PCA 手部参数，请提供完整轴角或最终旋转矩阵')
    if matrix:
        betas, expressions = 10, 0
        require(flat and motion['betas'].shape in [(1, 10), (frames, 10)], '最终矩阵模型配置无效')
        R = motion['joint_rotations']
        require(R.shape == (frames, 55, 3, 3) and R.dtype == np.float32 and np.isfinite(R).all()
                and np.allclose(R @ R.swapaxes(-1, -2), np.eye(3), atol=2e-5, rtol=0)
                and np.allclose(np.linalg.det(R), 1, atol=2e-5, rtol=0), '最终旋转矩阵无效')
        for key in ['hand_accepted', 'hand_view_count']:
            a = motion[key]
            require(a.shape == (frames, 2) and np.isfinite(a).all(), f'手部观测证据无效：{key}')
        require(motion['hand_accepted'].dtype.kind == 'b' and motion['hand_view_count'].dtype.kind in 'iu'
                and (motion['hand_view_count'] >= 0).all(), '手部有效性或观测数量无效')
        widths = {'transl': 3, 'betas': 10}
    else:
        betas, expressions = motion['betas'].shape[-1], motion['expression'].shape[-1]
        require(1 <= betas <= 300 and 1 <= expressions <= 100, '形状或表情参数维数超出 Viewer 范围')
        widths = {'global_orient': 3, 'body_pose': 63, 'jaw_pose': 3, 'leye_pose': 3,
                  'reye_pose': 3, 'left_hand_pose': 45, 'right_hand_pose': 45,
                  'transl': 3, 'betas': betas, 'expression': expressions}
    for key, width in widths.items():
        a = motion[key]
        allowed = [(frames, width)] + ([(1, width), (width,)] if key in ('betas', 'expression') else [])
        require(a.shape in allowed and np.isfinite(a).all(), f'动作参数维度或数值无效：{key}')
    body = motion.get('body_observed', layer.get('body_observed'))
    if body is None and layer.get('observations'):
        with np.load(receipt.get(layer['observations']), allow_pickle=False) as observations:
            body = observations['body_observed'].copy()
    if body is None and layer.get('body_observed_frames') == frames:
        body = np.ones(frames, dtype=bool)
    body = np.asarray(body)
    require(body.shape == (frames,) and body.dtype.kind == 'b', '缺少逐帧人体观测证据')
    require(int(body.sum()) == layer['body_observed_frames'], '人体有效性与来源统计不一致')
    source_model_sha = validate_model(args.model, betas, expressions, flat)
    if 'model_sha256' in motion:
        require(str(motion['model_sha256'].item()) == source_model_sha, '模型与动作参数的摘要不一致')
    model_path = temp / 'smplx.npz'
    if matrix:
        require('model_sha256' in motion and str(motion['model_sha256'].item()) == source_model_sha,
                '最终参数缺少绑定模型摘要')
        require(args.model.stat().st_size <= 256 * 1024**2, '模型超过浏览器预算')
        shutil.copyfile(args.model, model_path)
        model_sha = digest(model_path)
    else:
        model_sha = write_playback_model(args.model, model_path, betas, expressions, flat)
    motion['body_observed'] = body
    motion['model_sha256'] = np.array(model_sha)
    motion['source_model_sha256'] = np.array(source_model_sha)
    pack = Package()
    pack.add('models/smplx.npz', model_path, 'smplx_playback_model')
    videos, ids, points, observed = [], set(), [], []
    counts = {'gopro': 0, 'ego': 0}
    if matrix:
        pre = receipt.json(layer['preview'])
        proof = pre['model']
        require(pre.get('format') == 'synaexo-parameter-preview-v1'
                and pre['recording_id'] == source['recording_id']
                and pre['parameters'] == layer['parameters'] and pre['world_frame'] == layer['world_frame']
                and pre['clock_id'] == layer['clock_id'] and proof['model_sha256'] == model_sha
                and proof['frames'] == frames and 0 <= proof['max_abs_vertex_error_m'] <= 0.00002
                and proof['max_allowed_error_m'] == 0.00002, '参数预览配方与所选结果或恢复证明不一致')
        projections = [{**c['proxy'], 'camera_id': c['camera_id'], 'frames': frames} for c in pre['cameras']]
    else:
        pre = receipt.json(layer['preprocessing'])
        projections = layer['projections']
    require(1 <= len(projections) <= 16, '相机数量超出 Viewer 范围')
    for projection in projections:
        cid = projection['camera_id']
        require(isinstance(cid, str) and cid and cid not in ids, '相机身份缺失或重复')
        ids.add(cid)
        poses = [v for v in pre['cameras'] if v['camera_id'] == cid]
        require(len(poses) == 1 and poses[0]['kind'] in counts, f'相机类型无效：{cid}')
        kind = poses[0]['kind']
        counts[kind] += 1
        view = ('EXO' if kind == 'gopro' else 'EGO') + str(counts[kind]).zfill(2)
        mapping = poses[0]['frame_map'] if matrix else receipt.named(cid + '-source-frames.npz')
        mapping_path = receipt.get(mapping, limit=128 * 1024**2)
        validate_npz_budget(mapping_path)
        with np.load(mapping_path, allow_pickle=False) as z:
            t, valid = z['reference_timestamps_ns'], z['source_observed']
            require(t.dtype.kind in 'iu' and t.shape == (frames,)
                    and [int(v) - origin for v in t] == times
                    and valid.shape == (frames,) and np.isin(valid, [0, 1]).all(),
                    f'逐帧来源与主时间轴不一致：{cid}')
            observed.append(valid.astype(bool))
        pts = timestamps(projection['video_pts_ns'], frames, view)
        require(projection['frames'] == frames
                and max(abs(p-t) for p, t in zip(pts, times)) <= 11_112,
                f'视频帧数或 PTS 与主时间轴不一致：{cid}')
        dimensions = projection['image_size']
        require(len(dimensions) == 2 and all(type(v) is int and 0 < v <= 8192 for v in dimensions), f'视频分辨率无效：{cid}')
        path = projection['path']
        require(path.endswith('.mp4'), f'可视化视频必须是 MP4：{cid}')
        local = receipt.get(path)
        if matrix:
            camera = poses[0]
            cal = camera['calibration']
            K = np.asarray(cal['K'], dtype=np.float64)
            require(K.shape == (3, 3) and np.isfinite(K).all() and K[0, 0] > 0 and K[1, 1] > 0
                    and np.array_equal(K[2], [0, 0, 1]),
                    f'相机内参无效：{cid}')
            require(isinstance(cal['image_size'], list) and len(cal['image_size']) == 2
                    and all(type(v) is int and v > 0 for v in cal['image_size']), f'相机标定分辨率无效：{cid}')
            width, height = cal['image_size']
            K = np.diag([dimensions[0]/width, dimensions[1]/height, 1.]) @ K
            transforms = np.asarray(camera['T_world_from_camera'], dtype=np.float64)
            if transforms.shape == (4, 4): transforms = np.broadcast_to(transforms, (frames, 4, 4))
            valid = np.asarray(camera['pose_valid'])
            require(transforms.shape == (frames, 4, 4) and np.isfinite(transforms).all()
                    and np.allclose(transforms[:, 3], [0, 0, 0, 1], atol=1e-6, rtol=0)
                    and valid.shape == (frames,) and valid.dtype.kind == 'b', f'相机世界外参无效：{cid}')
            i = len(videos)
            motion[f'preview_camera_{i}_K'] = K
            motion[f'preview_camera_{i}_poses'] = transforms
            motion[f'preview_camera_{i}_pose_valid'] = valid
        pack.add(f'videos/{view.lower()}.mp4', local, 'clean_proxy_video' if matrix else 'baked_projection_video', receipt.files[path])
        videos.append({'camera_id': cid, 'view_id': view, 'kind': kind,
                       'image_size': dimensions, 'bytes': local.stat().st_size, 'sha256': digest(local),
                       'content': 'clean_proxy' if matrix else 'baked_projection'})
        points.append(pts)
    metadata = {'format': 'synaexo-visualization', 'schema_version': 1,
                'recording_id': source['recording_id'], 'result_id': published['version'],
                'representation': 'smplx_local_rotations' if matrix else 'smplx_axis_angle',
                'physical_accuracy_passed': layer['physical_accuracy_passed'],
                'model': {'sha256': model_sha, 'source_sha256': source_model_sha,
                          'bytes': model_path.stat().st_size, 'num_betas': betas, 'num_expression': expressions},
                'videos': videos}
    motion['preview_metadata'] = np.array(json.dumps(metadata, ensure_ascii=False, separators=(',', ':')))
    motion['preview_video_pts_ns'] = np.asarray(points, dtype=np.int64)
    motion['preview_source_observed'] = np.asarray(observed, dtype=bool)
    motion_path = temp / 'preview-motion.npz'
    np.savez_compressed(motion_path, **motion)
    require(motion_path.stat().st_size <= 128 * 1024**2, '动作参数超过浏览器预算')
    validate_npz_budget(motion_path)
    pack.add('motions/subject_01/smplx_parameters.npz', motion_path, metadata['representation'])
    readme = temp / 'README.md'
    readme.write_text(visualization_readme(metadata, frames, times[-1], layer['world_frame']), encoding='utf-8')
    pack.add('README.md', readme, 'readme')
    pack.write(args.output, force=args.force)
    return {'archive': str(args.output.resolve()), 'bytes': args.output.stat().st_size,
            'sha256': digest(args.output), 'verified_payloads': len(pack.files),
            'recording_id': source['recording_id'], 'result_id': published['version'],
            'source_layer_version': layer['version'], 'source_manifest': args.manifest,
            'frames': frames, 'duration_ns': times[-1], 'cameras': [v['view_id'] for v in videos],
            'model_sha256': model_sha, 'source_model_sha256': source_model_sha,
            'source_parameters_sha256': receipt.files[layer['parameters']]['sha256'],
            'physical_accuracy_passed': layer['physical_accuracy_passed'],
            'display_style': layer.get('display_style')}


def public_metadata(value):
    """Reject private locations and credentials before copying result metadata."""
    if isinstance(value, dict):
        for key, child in value.items():
            require(not re.search(r'(?i)(password|secret|credential|access.?key|session.?token|authorization)', key),
                    '交付元信息包含凭据字段，未导出')
            public_metadata(child)
    elif isinstance(value, list):
        for child in value:
            public_metadata(child)
    elif isinstance(value, bytes):
        public_metadata(value.decode('utf-8'))
    elif isinstance(value, str):
        require(not value.startswith(('/', '\\', '~/'))
                and not re.search(r'[A-Za-z][A-Za-z0-9+.-]*://|[A-Za-z]:[\\/]', value),
                '交付元信息包含内部路径或远程地址，未导出')


def publish_delivery(args, receipt, report, stage):
    """Publish the data and visualization together; retries reuse identical files."""
    visualization = stage / f'syanexo-{report["sha256"]}.zip'
    os.replace(args.output, visualization)
    report['archive'] = str(visualization)
    from delivery_bundle import DeliveryPlan, build_delivery
    plan = getattr(args, 'delivery_plan', None) or DeliveryPlan(receipt)
    build_delivery(plan, report, stage / 'delivery')
    entries = {p.relative_to(stage).as_posix(): digest(p) for p in sorted(stage.rglob('*')) if p.is_file()}
    content_hash = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
    target = args.output_dir / f'synaexo-delivery-{content_hash}'
    if target.exists():
        require(target.is_dir() and not target.is_symlink(), '联合交付输出已存在且不是普通目录')
        existing = {}
        for path in target.rglob('*'):
            require(not path.is_symlink(), '联合交付输出包含符号链接，未覆盖')
            if path.is_file():
                existing[path.relative_to(target).as_posix()] = digest(path)
        require(existing == entries, f'同名交付目录内容不一致，未覆盖：{target}')
    else:
        os.rename(stage, target)
    report['archive'] = str((target / visualization.name).resolve())
    report['delivery'] = str((target / 'delivery').resolve())
    report['directory'] = str(target.resolve())
    report['delivery_files'] = len(entries) - 1
    return report


def main(with_delivery=False):
    description = ('联合导出同一个 run 的完整数据交付包与可视化 ZIP' if with_delivery else
                   '将一个已发布的 SMPL-X 结果导出为可视化 ZIP，或联合导出数据交付包')
    parser = argparse.ArgumentParser(description=description)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--manifest', help='S3 标准结果 manifest 或已有可视化结果回执')
    group.add_argument('--csv', type=Path, help='结果索引 CSV；配合 --recording-id 使用')
    parser.add_argument('--result-manifest', help='旧回执联合导出时，补充同一 run 的标准 synaexo_result 清单')
    parser.add_argument('--recording-id', help='CSV 中完整、唯一的录制 ID')
    parser.add_argument('--model', type=Path, required=True, help='对应完整模型 NPZ；新矩阵结果原字节复制，既有轴角结果按维数准备')
    parser.add_argument('--output-dir', type=Path, required=True, help='导出目录；联合模式生成含 delivery/ 和可视化 ZIP 的独立子目录')
    parser.add_argument('--with-delivery', action='store_true', default=with_delivery,
                        help='同时生成该 run 的数据交付包，与可视化 ZIP 放在同一个独立目录')
    cache = Path(tempfile.gettempdir()) / 'synaexo-package-cache'
    parser.add_argument('--cache-dir', type=Path, default=cache, help=f'通过 SHA-256 校验的载荷缓存目录（默认：{cache}）')
    parser.add_argument('--endpoint-url', help='S3 兼容服务地址；未传时使用 AWS SDK 配置')
    parser.add_argument('--storage-config', type=Path, help='可选的本机对象存储 JSON 配置，使用 profile / profiles 结构')
    parser.add_argument('--addressing-style', choices=['auto', 'virtual', 'path'], default='auto')
    parser.add_argument('--force', action='store_true', help='覆盖单独导出的同名 ZIP；不覆盖联合交付目录')
    args = parser.parse_args()
    try:
        if args.csv:
            require(args.recording_id, '--csv 需要 --recording-id 指定完整录制 ID')
            args.manifest, _ = select_source(args.csv, args.recording_id)
        args.output_dir.mkdir(parents=True, exist_ok=True)
        client = storage_client(args)
        receipt = Receipt(client, args.manifest, args.cache_dir,
                          args.recording_id if args.csv else None)
        if args.with_delivery:
            from delivery_bundle import DeliveryPlan
            delivery_receipt = (Receipt(client, args.result_manifest, args.cache_dir)
                                if args.result_manifest else receipt)
            args.delivery_plan = DeliveryPlan(delivery_receipt)
            delivery = delivery_receipt.document
            require(receipt.manifest['recording_id'] in {delivery['recording_id'], delivery['source_recording_id']}
                    and receipt.manifest['published']['version'] == delivery['result_id'],
                    '补充结果清单与可视化回执不是同一录制/run')
        elif args.result_manifest:
            require(False, '--result-manifest 仅用于联合导出')
        with tempfile.TemporaryDirectory(prefix='.synaexo-package-', dir=args.output_dir) as directory:
            temporary = Path(directory)
            scratch, stage = temporary / 'scratch', temporary / 'publish'
            scratch.mkdir()
            stage.mkdir()
            args.output = stage / 'preview.zip'
            report = build(args, receipt, scratch)
            if args.with_delivery:
                report = publish_delivery(args, receipt, report, stage)
            else:
                target = args.output_dir / f'syanexo-{report["sha256"]}.zip'
                if target.exists() and not args.force:
                    require(digest(target) == report['sha256'], f'同名附件已损坏：{target}；覆盖请使用 --force')
                else:
                    os.replace(args.output, target)
                report['archive'] = str(target.resolve())
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError, csv.Error, zipfile.BadZipFile, BotoCoreError, ClientError) as error:
        parser.exit(1, f'package_recording: 打包失败：{error}\n请核对来源回执、模型、S3 配置和输出路径。\n')


if __name__ == '__main__':
    main()
