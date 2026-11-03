#!/usr/bin/env python3
"""Build a local Viewer ZIP from a published S3 receipt."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
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
        if expected_recording_id is not None:
            require(self.manifest['recording_id'] == expected_recording_id,
                    'CSV 中的录制 ID 与 S3 manifest 不一致')
        self.files = {}
        for item in self.manifest['files']:
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

    def named(self, name):
        matches = [p for p in self.files if PurePosixPath(p).name == name]
        require(len(matches) == 1, f'回执中找不到唯一文件：{name}')
        return matches[0]

    def get(self, source_path):
        item = self.files[source_path]
        require(item['bytes'] <= FILE_LIMIT, f'文件超过 Viewer 预算：{source_path}')
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


def trim_model(source, destination, betas, expressions, flat_hand_mean):
    required = {'v_template': (10475, 3), 'posedirs': (10475, 3, 486),
                'J_regressor': (55, 10475), 'weights': (10475, 55),
                'kintree_table': (2, 55)}
    with np.load(source, allow_pickle=False) as model:
        arrays = {key: model[key] for key in [*required, 'f']}
        for key, shape in required.items():
            require(arrays[key].shape == shape and np.isfinite(arrays[key]).all(),
                    f'模型数组维度或数值无效：{key}')
        faces = arrays['f']
        require(faces.ndim == 2 and faces.shape[1] == 3 and faces.dtype.kind in 'iu'
                and faces.size > 0 and faces.min() >= 0 and faces.max() < 10475,
                '模型三角面无效')
        parents = arrays['kintree_table'][0]
        require((parents[0] < 0 or parents[0] >= 55)
                and all(0 <= parents[i] < i for i in range(1, 55)), '模型关节层级无效')
        shape = model['shapedirs']
        require(shape.ndim == 3 and shape.shape[:2] == (10475, 3)
                and shape.shape[2] >= max(betas, 300 + expressions), '模型形状或表情基底不足')
        compact = np.zeros((10475, 3, 300 + expressions), dtype=np.float32)
        compact[:, :, :betas] = shape[:, :, :betas]
        compact[:, :, 300:] = shape[:, :, 300:300 + expressions]
        require(np.isfinite(compact).all(), '模型有效形状基底含无效数值')
        arrays['shapedirs'] = compact
        if not flat_hand_mean:
            for key in ['hands_meanl', 'hands_meanr']:
                arrays[key] = model[key]
                require(arrays[key].shape == (45,) and np.isfinite(arrays[key]).all(),
                        f'模型平均手势无效：{key}')
    np.savez_compressed(destination, **{k: np.asfortranarray(v) for k, v in arrays.items()})
    return {'source_sha256': digest(source), 'sha256': digest(destination),
            'num_betas': betas, 'num_expression': expressions, 'expression_offset': 300,
            'retained_arrays': list(arrays), 'active_shape_basis_float32_exact': True}


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

    def json(self, path, value, role, temp):
        local = temp / f'{len(self.files)}.json'
        local.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        require(local.stat().st_size <= JSON_LIMIT, f'JSON 超出 Viewer 预算：{path}')
        self.add(path, local, role)

    def write(self, output, manifest, force=False):
        require(force or not output.exists(), f'输出已存在：{output}；覆盖请使用 --force')
        output.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=output.parent, suffix='.zip.part')
        os.close(fd)
        try:
            with zipfile.ZipFile(name, 'w', allowZip64=True) as archive:
                archive.writestr('manifest.json', json.dumps({**manifest, 'files': self.files}, ensure_ascii=False, indent=2), compress_type=zipfile.ZIP_DEFLATED)
                for path, local in self.items.items():
                    archive.write(local, path, compress_type=zipfile.ZIP_DEFLATED if path.endswith('.json') else zipfile.ZIP_STORED)
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


def build(args, receipt, display_name, temp):
    source = receipt.manifest
    published = source['published']
    require(published['state'] == 'succeeded', '来源结果未发布成功，请检查 manifest')
    layer = receipt.json(published['raw_smplx'])
    pre = receipt.json(layer['preprocessing'])
    require(layer['recording_id'] == source['recording_id']
            and layer['units'] == 'm' and isinstance(layer['world_frame'], str)
            and layer['world_frame'] and type(layer['physical_accuracy_passed']) is bool,
            '结果身份、坐标系、单位或质检状态无效')
    frames = layer['frames']
    require(type(frames) is int and frames > 0, '人体结果帧数无效')
    body = layer.get('body_observed')
    require((isinstance(body, list) and len(body) == frames and all(type(v) is bool for v in body))
            or (body is None and layer.get('body_observed_frames') == frames), '缺少逐帧人体观测证据')
    pack = Package()

    def original(path, source_path, role):
        pack.add(path, receipt.get(source_path), role, receipt.files[source_path])

    motion_path = receipt.get(layer['parameters'])
    with np.load(motion_path, allow_pickle=False) as motion:
        ts = motion['reference_timestamps_ns']
        require(ts.dtype.kind in 'iu' and ts.shape == (frames,)
                and all(abs(int(t)) <= SAFE_INTEGER for t in ts),
                '参数缺少精确逐帧时间或超过 JavaScript 安全整数范围')
        origin = int(ts[0])
        times = timestamps([int(t) - origin for t in ts], frames, '主时间轴')
        require(str(motion['coordinate_frame'].item()) == layer['world_frame']
                and str(motion['units'].item()) == 'm', '参数坐标系与结果不一致')
        require(motion['flat_hand_mean'].dtype.kind == 'b' and motion['use_pca'].dtype.kind == 'b', '参数必须声明手部表示')
        flat, pca = bool(motion['flat_hand_mean'].item()), bool(motion['use_pca'].item())
        require(not pca, 'Viewer 需要完整手部轴角参数，不支持 PCA 参数')
        betas, expressions = motion['betas'].shape[-1], motion['expression'].shape[-1]
        require(1 <= betas <= 300 and 1 <= expressions <= 100, '形状或表情参数维数超出 Viewer 范围')
        widths = {'global_orient': 3, 'body_pose': 63, 'jaw_pose': 3, 'leye_pose': 3,
                  'reye_pose': 3, 'left_hand_pose': 45, 'right_hand_pose': 45,
                  'transl': 3, 'betas': betas, 'expression': expressions}
        for key, width in widths.items():
            a = motion[key]
            allowed = [(frames, width)] + ([(1, width), (width,)] if key in ('betas', 'expression') else [])
            require(a.shape in allowed and np.isfinite(a).all(), f'动作参数维度或数值无效：{key}')
    original('motions/subject_01/smplx_parameters.npz', layer['parameters'], 'smplx_axis_angle')
    model_path = temp / 'model.npz'
    model_report = trim_model(args.model, model_path, betas, expressions, flat)
    model_name = 'models/smplx.npz'
    pack.add(model_name, model_path, 'smplx_model')
    pack.json('validation/model-trim.json', model_report, 'validation', temp)
    pack.json('timeline/reference.json', {'clock_id': layer['clock_id'], 'frames': frames,
              'reference_origin_ns': str(origin), 'reference_epoch_ns': str(pre['time']['reference_epoch_ns']),
              'relative_timestamps_ns': times}, 'reference_timeline', temp)
    cameras, ids = [], set()
    counts = {'gopro': 0, 'ego': 0}
    projections = layer['projections']
    require(1 <= len(projections) <= 16, '相机数量超出 Viewer 范围')
    for projection in projections:
        cid = projection['camera_id']
        require(isinstance(cid, str) and cid and cid not in ids, '相机身份缺失或重复')
        ids.add(cid)
        poses = [v for v in pre['cameras'] if v['camera_id'] == cid]
        require(len(poses) == 1 and poses[0]['kind'] in counts, f'相机位姿证据无效：{cid}')
        pose = poses[0]
        kind = pose['kind']
        counts[kind] += 1
        view = ('EXO' if kind == 'gopro' else 'EGO') + str(counts[kind]).zfill(2)
        info = receipt.json(receipt.named(cid + '-source.json'))
        mapping = receipt.named(cid + '-source-frames.npz')
        with np.load(receipt.get(mapping), allow_pickle=False) as z:
            t, observed = z['reference_timestamps_ns'], z['source_observed']
            require(t.dtype.kind in 'iu' and t.shape == (frames,)
                    and [int(v) - origin for v in t] == times
                    and observed.shape == (frames,) and np.isin(observed, [0, 1]).all(),
                    f'逐帧来源与主时间轴不一致：{cid}')
        pts = timestamps(projection['video_pts_ns'], frames, view)
        require(projection['frames'] == frames, f'视频帧数不一致：{cid}')
        dimensions = projection['image_size']
        require(len(dimensions) == 2 and all(type(v) is int and 0 < v <= 8192 for v in dimensions), f'视频分辨率无效：{cid}')
        valid = pose['pose_valid']
        require(len(valid) == frames and all(type(v) is bool for v in valid), f'位姿有效状态无效：{cid}')
        transform = np.asarray(pose['T_world_from_camera'])
        require(transform.shape in [(4, 4), (frames, 4, 4)] and np.isfinite(transform).all()
                and np.max(np.abs(transform[..., 3, :] - [0, 0, 0, 1])) < 1e-6,
                f'相机变换无效：{cid}')
        calibration = info['calibration']
        k = np.asarray(calibration['K'])
        require(k.shape == (3, 3) and np.isfinite(k).all() and k[0, 0] > 0 and k[1, 1] > 0
                and len(calibration['image_size']) == 2
                and all(type(v) is int and v > 0 for v in calibration['image_size']), f'相机内参无效：{cid}')
        video, frame_map = f'previews/{view.lower()}.mp4', f'timeline/source_frames/{view.lower()}.npz'
        require(projection['path'].endswith('.mp4'), f'已有叠加视频必须是 MP4：{cid}')
        original(video, projection['path'], 'baked_projection_video')
        original(frame_map, mapping, 'source_frame_mapping')
        cameras.append({'camera_id': cid, 'view_id': view, 'kind': kind, 'video': video,
                        'content': 'baked_projection', 'image_size': dimensions, 'video_pts_ns': pts,
                        'source_frame_mapping': frame_map, 'calibration': calibration,
                        'T_world_from_camera': pose['T_world_from_camera'], 'pose_valid': valid})
    pack.json('calibration/cameras.json', {'world_frame': layer['world_frame'], 'units': 'm', 'cameras': cameras}, 'frozen_camera_evidence', temp)
    for name, path in [('layer', published['raw_smplx']), ('preprocessing', layer['preprocessing']), ('quality', layer['quality'])]:
        original(f'provenance/{name}.json', path, 'source_' + name)
    local_receipt = temp / 'source-manifest.json'
    local_receipt.write_bytes(receipt.raw)
    pack.add('provenance/source-manifest.json', local_receipt, 'source_receipt')
    manifest = {'format': 'synaexo-viewer-package', 'format_version': 1,
                'recording_id': source['recording_id'], 'result_id': published['version'],
                'display_name': display_name or source['recording_id'], 'world_frame': layer['world_frame'],
                'units': 'm', 'physical_accuracy_passed': layer['physical_accuracy_passed'],
                'parameters': {'path': 'motions/subject_01/smplx_parameters.npz', 'representation': 'legacy_smplx_axis_angle', 'timeline': 'timeline/reference.json', 'frames': frames, 'flat_hand_mean': flat, 'use_pca': pca},
                'model': {'path': model_name, 'source_sha256': model_report['source_sha256'], 'num_betas': betas, 'num_expression': expressions, 'expression_offset': 300},
                'cameras': 'calibration/cameras.json', 'source_manifest': args.manifest,
                'source_layer_version': layer['version'], 'video_content': 'existing_baked_projections'}
    pack.write(args.output, manifest, args.force)
    return {'archive': str(args.output.resolve()), 'bytes': args.output.stat().st_size,
            'sha256': digest(args.output), 'verified_payloads': len(pack.files),
            'recording_id': source['recording_id'], 'result_id': published['version'],
            'source_layer_version': layer['version'], 'source_manifest': args.manifest,
            'frames': frames, 'duration_ns': times[-1], 'cameras': [c['view_id'] for c in cameras],
            'physical_accuracy_passed': layer['physical_accuracy_passed'], 'display_style': layer.get('display_style')}


def main():
    parser = argparse.ArgumentParser(description='将已发布的 SMPL-X 结果打包为本地 Viewer ZIP')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--manifest', help='来源 S3 manifest 地址')
    group.add_argument('--csv', type=Path, help='结果索引 CSV；配合 --recording-id 使用')
    parser.add_argument('--recording-id', help='CSV 中完整、唯一的录制 ID')
    parser.add_argument('--model', type=Path, required=True, help='此结果对应的完整 SMPL-X 模型 NPZ')
    parser.add_argument('--output', type=Path, required=True, help='输出 ZIP 路径')
    cache = Path(tempfile.gettempdir()) / 'synaexo-package-cache'
    parser.add_argument('--cache-dir', type=Path, default=cache, help=f'通过 SHA-256 校验的载荷缓存目录（默认：{cache}）')
    parser.add_argument('--endpoint-url', help='S3 兼容服务地址；未传时使用 AWS SDK 配置')
    parser.add_argument('--storage-config', type=Path, help='可选的本机对象存储 JSON 配置，使用 profile / profiles 结构')
    parser.add_argument('--addressing-style', choices=['auto', 'virtual', 'path'], default='auto')
    parser.add_argument('--force', action='store_true', help='覆盖已有输出 ZIP')
    args = parser.parse_args()
    try:
        display_name = None
        if args.csv:
            require(args.recording_id, '--csv 需要 --recording-id 指定完整录制 ID')
            args.manifest, display_name = select_source(args.csv, args.recording_id)
        require(args.force or not args.output.exists(), f'输出已存在：{args.output}；覆盖请使用 --force')
        client = storage_client(args)
        receipt = Receipt(client, args.manifest, args.cache_dir,
                          args.recording_id if args.csv else None)
        with tempfile.TemporaryDirectory(prefix='synaexo-package-') as directory:
            report = build(args, receipt, display_name, Path(directory))
        args.output.with_suffix('.report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, BotoCoreError, ClientError) as error:
        parser.exit(1, f'package_recording: 打包失败：{error}\n请核对来源回执、模型、S3 配置和输出路径。\n')


if __name__ == '__main__':
    main()
