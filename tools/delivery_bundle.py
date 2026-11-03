"""Export original camera inputs and one standard SynaExo result together."""
import csv
import hashlib
import json
import shutil

import numpy as np

from package_recording import JSON_LIMIT, digest, public_metadata, require, safe_path


def component(value):
    require('/' not in safe_path(value), f'身份不能包含目录：{value}')
    return value


class DeliveryPlan:
    def __init__(self, receipt):
        require(receipt.standard,
                '完整交付需要 synaexo_result 标准结果清单；旧回执请补充 --result-manifest，不能用叠加视频代替原片')
        self.receipt = receipt
        doc = receipt.document
        root_ref = doc['recording_manifest']
        require(root_ref['path'] == 'manifest.json', '录制清单引用必须位于录制根目录')
        receipt.register(root_ref)
        self.recording = receipt.json('manifest.json')
        root = self.recording
        require(root.get('format') == 'synaexo_recording' and root.get('schema_version') == 1
                and root['recording_id'] == doc['recording_id']
                and root['source_recording_id'] == doc['source_recording_id'], '录制清单与所选结果身份不一致')
        self.layer = receipt.json(receipt.manifest['published']['raw_smplx'])
        layer = self.layer
        require(layer['recording_id'] == doc['recording_id'] and layer['version'] == doc['result_id']
                and layer.get('source_recording_id', doc['source_recording_id']) == doc['source_recording_id'],
                '人体结果与所选 run 身份不一致')
        self.pre = receipt.json(layer['preprocessing'])
        self.clock = receipt.result_prefix + 'timeline/clock_models.json'
        self.sync_quality = receipt.result_prefix + 'timeline/quality.json'
        require(self.clock in receipt.files and self.sync_quality in receipt.files, '结果缺少时钟映射或同步质检')
        clock = receipt.json(self.clock)
        require(clock['clock_id'] == layer['clock_id'], '同步参考时钟与人体结果不一致')
        self.epoch = clock.get('reference_epoch_ns')
        require(self.epoch is None or type(self.epoch) is int, '参考 epoch 必须保留整数纳秒')
        entries = {}
        for row in root['files']:
            require(row['path'].startswith(('raw/', 'calibration/')), '录制清单包含输入分区以外的文件')
            path = receipt.register(row)
            require(path not in entries, f'录制清单重复路径：{path}')
            entries[path] = row
        for row in doc.get('calibration_files', []):
            require(row['path'].startswith('calibration/'), '结果标定引用不在 calibration 下')
            receipt.register(row)
        self.cameras = []
        seen = set()
        for camera in self.pre['cameras']:
            cid = component(camera['camera_id'])
            require(cid not in seen and camera['kind'] in {'gopro', 'ego'}, f'相机身份/类型无效：{cid}')
            seen.add(cid)
            kind = camera['kind']
            videos = [v for v in entries.values() if v.get('device_type') == kind
                      and (cid == v.get('device_id') or kind == 'ego' and cid == 'ego-' + str(v.get('device_id')))]
            require(videos, f'相机 {cid} 缺少对应原始视频')
            device = component(videos[0]['device_id'])
            for video in videos:
                expected = f"raw/{kind}/{device}/{component(video['asset_id'])}/{component(video['source_filename'])}"
                require(video['path'] == expected,
                        f'相机 {cid} 原始视频身份或文件路径无效')
            suffix = f'/{kind}/{device}/intrinsics.json'
            preferred = [v['path'] for v in doc.get('calibration_files', []) if v['path'].endswith(suffix)]
            intrinsics = preferred or [p for p in entries if p.startswith('calibration/') and p.endswith(suffix)]
            require(len(intrinsics) == 1, f'相机 {cid} 缺少唯一冻结内参')
            intrinsic = receipt.json(intrinsics[0])
            eyes = intrinsic.get('eyes')
            require(not isinstance(eyes, dict) or set(eyes) == {'left', 'right'}, f'相机 {cid} 双目内参不完整')
            values = eyes.values() if isinstance(eyes, dict) else [intrinsic.get('intrinsics', intrinsic)]
            for value in values:
                matrix = np.asarray(value.get('camera_matrix', value.get('K')), dtype=float)
                size = value.get('image_size')
                require(matrix.shape == (3, 3) and np.isfinite(matrix).all() and isinstance(size, list)
                        and len(size) == 2 and all(type(n) is int and n > 0 for n in size)
                        and value.get('distortion_model', value.get('model'))
                        and isinstance(value.get('dist_coeffs', value.get('distortion')), list)
                        and np.isfinite(value.get('dist_coeffs', value.get('distortion'))).all(),
                        f'相机 {cid} 内参缺少有效矩阵或原视频分辨率')
            stereo = None
            if isinstance(eyes, dict) and set(eyes) == {'left', 'right'}:
                stereo = intrinsics[0].removesuffix('intrinsics.json') + 'extrinsics.json'
                require(stereo in receipt.files, f'相机 {cid} 缺少双目相对外参')
                pair = receipt.json(stereo)['stereo']
                rotation, translation = np.asarray(pair['R_right_from_left']), np.asarray(pair['t_right_from_left_m'])
                require(rotation.shape == (3, 3) and translation.shape in {(3,), (3, 1)}
                        and np.isfinite(rotation).all() and np.isfinite(translation).all()
                        and pair.get('direction'), f'相机 {cid} 双目 R/t 或方向无效')
            prefix = receipt.result_prefix
            pose_manifest = prefix + f'trajectories/cameras/{cid}/manifest.json'
            poses = prefix + f'trajectories/cameras/{cid}/extrinsics.jsonl'
            mapping = prefix + f'timeline/frame_mapping/{cid}.csv'
            require(all(p in receipt.files for p in [pose_manifest, poses, mapping]),
                    f'相机 {cid} 缺少世界外参、轨迹声明或逐帧同步映射')
            pose = receipt.json(pose_manifest)
            require(pose['stream_id'] == cid and pose['target_frame'] == layer['world_frame']
                    and pose['transform_direction'] == 'camera_to_world' and pose['translation_units'] == 'm'
                    and pose['source_frame'] and pose.get('mode') and pose['file']['path'] == 'extrinsics.jsonl'
                    and pose['file']['sha256'] == receipt.files[poses]['sha256']
                    and pose['file']['size_bytes'] == receipt.files[poses]['bytes'],
                    f'相机 {cid} 外参身份、方向、单位或文件引用不一致')
            require(pose.get('reference_epoch_ns') == self.epoch, f'相机 {cid} 外参与同步时钟 epoch 不一致')
            require(cid in clock['models'], f'相机 {cid} 缺少源时钟映射')
            model = clock['models'][cid]
            require(isinstance(model, dict) and type(model.get('scale')) in (int, float)
                    and np.isfinite(model['scale']) and model['scale'] > 0
                    and type(model.get('offset_ns')) is int and model.get('reference_clock_id') == layer['clock_id'],
                    f'相机 {cid} 源时钟映射参数或身份无效')
            segments = self.segments(cid, kind, videos)
            self.cameras.append(dict(stream_id=cid, kind=kind, device_id=device, videos=videos,
                                     intrinsics=intrinsics[0], stereo_extrinsics=stereo,
                                     pose_manifest=pose_manifest, poses=poses, mapping=mapping, segments=segments))
        require(self.cameras, '结果没有相机输入，不能生成完整交付')

    def segments(self, cid, kind, videos):
        aligned = videos
        if kind == 'ego' and any(v.get('layout') == 'separate' for v in videos):
            aligned = [v for v in videos if v.get('slot') == 'left']
            require(len(aligned) == 1, f'相机 {cid} 缺少明确的左目同步源')
        if len(aligned) == 1:
            return [dict(video=aligned[0], first_joined_index=0, frames=None, pts_offset_ns=0)]
        require(kind == 'gopro', f'相机 {cid} 的多文件输入缺少明确同步源')
        path = self.receipt.named(cid + '-chapters.json')
        ledger = self.receipt.json(path)['ordered_sources']
        ordered = sorted(aligned, key=lambda v: v['segment_index'])
        require(len(ledger) == len(ordered), f'相机 {cid} 原视频分段数量不一致')
        result, cursor = [], 0
        for index, (chapter, video) in enumerate(zip(ledger, ordered)):
            require(video['segment_index'] == index and chapter['sha256'] == video['sha256']
                    and chapter['first_joined_index'] == cursor and type(chapter['frames']) is int
                    and chapter['frames'] > 0 and type(chapter['pts_offset_ns']) is int,
                    f'相机 {cid} 分段顺序、摘要或实际 PTS 证据不一致')
            result.append(dict(video=video, **{k: chapter[k] for k in ['first_joined_index', 'frames', 'pts_offset_ns']}))
            cursor += chapter['frames']
        return result


def build_delivery(plan, visualization, destination):
    receipt, layer = plan.receipt, plan.layer
    doc = receipt.document
    identities = {doc['recording_id'], doc['source_recording_id']}
    require(visualization['recording_id'] in identities and visualization['result_id'] == doc['result_id']
            and visualization['source_parameters_sha256'] == receipt.files[layer['parameters']]['sha256']
            and visualization['physical_accuracy_passed'] == layer['physical_accuracy_passed'],
            '交付数据与可视化包的录制、run、动作摘要或质检状态不一致')
    destination.mkdir(parents=True)
    files = []

    def keep(source, target, role, large=False):
        path = destination / safe_path(target)
        require(not path.exists(), f'交付路径重复：{target}')
        path.parent.mkdir(parents=True, exist_ok=True)
        local = receipt.get(source, limit=None if large else 1024 ** 3)
        if source.endswith('.json'):
            public_metadata(receipt.json(source))
        shutil.copyfile(local, path)
        require(digest(path) == receipt.files[source]['sha256'], f'交付复制后摘要不一致：{target}')
        files.append(dict(path=target, role=role, bytes=path.stat().st_size, sha256=digest(path)))
        return path

    def generated(target, value, role):
        public_metadata(value)
        path = destination / safe_path(target)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        files.append(dict(path=target, role=role, bytes=path.stat().st_size, sha256=digest(path)))

    parameters = 'motions/subject_01/smplx_parameters.npz'
    original = keep(layer['parameters'], parameters, 'smplx_parameters')
    keep(layer['quality'], 'motions/subject_01/quality.json', 'human_quality')
    with np.load(original, allow_pickle=False) as motion:
        times = motion['reference_timestamps_ns'].copy()
        require(times.shape == (layer['frames'],) and times.dtype.kind in 'iu'
                and np.all(times[1:] > times[:-1]), '动作主时间轴无效')
        for key in motion.files:
            public_metadata({key: motion[key].tolist() if motion[key].dtype.kind in 'US' else None})
        body = motion['body_observed'].copy() if 'body_observed' in motion else layer.get('body_observed')
    if layer.get('observations'):
        observations = keep(layer['observations'], 'motions/subject_01/observations.npz', 'human_observations')
        with np.load(observations, allow_pickle=False) as observed:
            supplied_body = observed['body_observed'].copy()
            require(body is None or np.array_equal(body, supplied_body), '动作参数与观测文件的人体有效性不一致')
            body = supplied_body
            if 'reference_timestamps_ns' in observed:
                require(np.array_equal(observed['reference_timestamps_ns'], times), '人体观测与主时间轴不一致')
    else:
        if body is None and layer.get('body_observed_frames') == len(times):
            body = np.ones(len(times), dtype=bool)
        observations = destination / 'motions/subject_01/observations.npz'
        np.savez_compressed(observations, reference_timestamps_ns=times, body_observed=body)
        files.append(dict(path=observations.relative_to(destination).as_posix(), role='human_observations',
                          bytes=observations.stat().st_size, sha256=digest(observations)))
    body = np.asarray(body)
    require(body.shape == times.shape and body.dtype.kind == 'b'
            and int(body.sum()) == layer['body_observed_frames'], '缺少有效的逐帧人体观测证据')
    keep(plan.clock, 'timeline/clock_models.json', 'clock_models')
    keep(plan.sync_quality, 'timeline/quality.json', 'sync_quality')
    generated('timeline/reference.json', dict(clock_id=layer['clock_id'], timestamp_units='ns',
              reference_epoch_ns=str(plan.epoch) if plan.epoch is not None else None,
              timestamps=dict(path=parameters, array='reference_timestamps_ns'), frames=len(times),
              start_time_ns=str(int(times[0])), end_time_ns=str(int(times[-1]))), 'reference_timeline')
    cameras, copied_calibrations = [], set()
    for camera in plan.cameras:
        cid = camera['stream_id']
        for calibration in [camera['intrinsics'], camera['stereo_extrinsics']]:
            if calibration and calibration not in copied_calibrations:
                keep(calibration, calibration, 'frozen_calibration')
                copied_calibrations.add(calibration)
        pose_target = f'trajectories/cameras/{cid}/'
        pose_meta = receipt.json(camera['pose_manifest'])
        generated(pose_target + 'manifest.json',
                  {**pose_meta, 'file': {**pose_meta['file'], 'path': pose_target + 'extrinsics.jsonl'}}, 'camera_manifest')
        poses = keep(camera['poses'], pose_target + 'extrinsics.jsonl', 'camera_extrinsics')
        count = valid_count = 0
        with poses.open(encoding='utf-8') as stream:
            while line := stream.readline(JSON_LIMIT + 1):
                count += 1
                require(len(line.encode('utf-8')) <= JSON_LIMIT, f'相机 {cid} 外参 JSON 行过大')
                row = json.loads(line)
                public_metadata(row)
                require(count <= len(times) and type(row['reference_frame_index']) is int
                        and row['reference_frame_index'] == count - 1 and type(row['reference_time_ns']) is int
                        and row['reference_time_ns'] == int(times[count - 1]) and type(row['valid']) is bool,
                        f'相机 {cid} 外参时间或有效性无效')
                matrix = row['transform_matrix']
                if row['valid']:
                    matrix = np.asarray(matrix, dtype=float)
                    require(matrix.shape == (4, 4) and np.isfinite(matrix).all(), f'相机 {cid} 有效外参矩阵无效')
                    valid_count += 1
                else:
                    require(matrix is None, f'相机 {cid} 无效外参必须为 null')
        require(count == len(times) == pose_meta['sample_count'] and valid_count == pose_meta['valid_sample_count'],
                f'相机 {cid} 外参帧数或统计不一致')
        mapping = destination / f'timeline/frame_mapping/{cid}.csv'
        mapping.parent.mkdir(parents=True, exist_ok=True)
        count = 0
        with receipt.get(camera['mapping']).open(encoding='utf-8', newline='') as source, mapping.open('w', encoding='utf-8', newline='') as output:
            reader = csv.DictReader(source)
            fields = ['reference_frame_index', 'reference_time_ns', 'source_frame_index', 'source_time_ns', 'valid']
            require(reader.fieldnames == fields, f'相机 {cid} 帧映射字段不明确')
            writer = csv.DictWriter(output, fields + ['source_video', 'joined_source_frame_index', 'joined_source_time_ns'])
            writer.writeheader()
            for count, row in enumerate(reader, 1):
                require(count <= len(times) and int(row['reference_frame_index']) == count - 1
                        and int(row['reference_time_ns']) == int(times[count - 1])
                        and row['valid'] in {'true', 'false'}, f'相机 {cid} 帧映射时间或有效性无效')
                row.update(source_video='', joined_source_frame_index=row['source_frame_index'], joined_source_time_ns=row['source_time_ns'])
                if row['valid'] == 'true':
                    index = int(row['source_frame_index'])
                    matches = [s for s in camera['segments'] if index >= s['first_joined_index']
                               and (s['frames'] is None or index < s['first_joined_index'] + s['frames'])]
                    require(len(matches) == 1, f'相机 {cid} 帧无法定位到唯一原片分段')
                    segment = matches[0]
                    row.update(source_video='videos/' + segment['video']['path'].removeprefix('raw/'),
                               source_frame_index=index - segment['first_joined_index'],
                               source_time_ns=int(row['source_time_ns']) - segment['pts_offset_ns'])
                else:
                    require(not row['source_frame_index'] and not row['source_time_ns'], f'相机 {cid} 无效源帧必须留空')
                writer.writerow(row)
        require(count == len(times), f'相机 {cid} 帧映射数量不一致')
        files.append(dict(path=mapping.relative_to(destination).as_posix(), role='source_frame_mapping',
                          bytes=mapping.stat().st_size, sha256=digest(mapping), source_sha256=receipt.files[camera['mapping']]['sha256']))
        videos = []
        for video in camera['videos']:
            target = 'videos/' + video['path'].removeprefix('raw/')
            keep(video['path'], target, 'original_video', large=True)
            videos.append({**{k: v for k, v in video.items() if k != 'path'}, 'path': target})
        cameras.append(dict(stream_id=cid, device_id=camera['device_id'], kind=camera['kind'], videos=videos,
                            intrinsics=camera['intrinsics'], stereo_extrinsics=camera['stereo_extrinsics'],
                            extrinsics=pose_target + 'extrinsics.jsonl', trajectory_manifest=pose_target + 'manifest.json',
                            source_segments=[dict(path='videos/' + s['video']['path'].removeprefix('raw/'),
                                                  first_joined_index=s['first_joined_index'], frames=s['frames'],
                                                  pts_offset_ns=str(s['pts_offset_ns'])) for s in camera['segments']],
                            frame_mapping=mapping.relative_to(destination).as_posix()))
    manifest = dict(format='synaexo-delivery', schema_version=1, delivery_version='1.0.0',
                    recording_id=doc['recording_id'], source_recording_id=doc['source_recording_id'], result_id=doc['result_id'],
                    source_manifest_sha256=hashlib.sha256(receipt.raw).hexdigest(),
                    source_recording_manifest_sha256=doc['recording_manifest']['sha256'],
                    source_model_sha256=visualization['source_model_sha256'],
                    frames=len(times), coordinate_frame=layer['world_frame'], units='m', cameras=cameras,
                    clock_id=layer['clock_id'], reference_epoch_ns=str(plan.epoch) if plan.epoch is not None else None,
                    timeline='timeline/reference.json', parameters=parameters,
                    physical_accuracy_passed=layer['physical_accuracy_passed'], files=files)
    public_metadata(manifest)
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    listing = '\n'.join(f'- `{f["path"]}`：{f["role"]}。' for f in files)
    (destination / 'README.md').write_text(f'''# SynaExo 交付包 v1.0.0

- 录制 ID：`{doc['recording_id']}`；来源录制 ID：`{doc['source_recording_id']}`。
- run ID：`{doc['result_id']}`；坐标系：`{layer['world_frame']}`；单位：米。
- 内容：本 run 的人体结果、原始视频、冻结内参、相机世界外参、双目标定与同步映射。
- 源物理精度检查：{'通过' if layer['physical_accuracy_passed'] else '未通过'}，文件校验不改变源结论。

## 文件

`manifest.json` 列出实际文件、摘要及相机/原视频/标定/轨迹/同步的对应关系。
所有导出清单的载荷路径相对于本 `delivery/` 根目录。
{listing}

## 读取

NPZ 使用 `np.load(path, allow_pickle=False)`。动作数组和原始视频保持源字节，视频保留源文件名与分段；
EGO 的布局、左右顺序和 slot 见清单。分离式双目以来源定义的左目作为现有同步映射源，保留两目原片。
`timeline/reference.json` 定位主时间戳；时钟映射和同步质量分别见 `timeline/clock_models.json`、`timeline/quality.json`。
帧映射中的 `source_video` 定位包内原片，`source_frame_index`、`source_time_ns` 为段内实际帧和 PTS；
`joined_source_frame_index`、`joined_source_time_ns` 保留来源拼接域值，不以固定 FPS 换算。
相机世界外参的方向、时间、米制单位和静态/动态来源见各自轨迹清单；双目相对外参另在 calibration 下。
无效帧保留 false/null 或空源帧字段，不用单位矩阵或默认全有效补齐观测。

数据包不含回放模型权重；完整源模型摘要：`{visualization['source_model_sha256']}`。
同一 run 的可视化 ZIP 位于上一级目录，内含回放模型、动作及已烘焙人体的视频；原片与叠加视频分别提供。
''', encoding='utf-8')
    return manifest
