import csv
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import numpy as np
from botocore.response import StreamingBody

from package_recording import Package, Receipt, build, digest, safe_path, select_source, storage_client, timestamps


class MemoryS3:
    def __init__(self, objects):
        self.objects, self.reads = objects, []

    def get_object(self, Bucket, Key):
        self.reads.append(Key)
        value = self.objects[Key]
        return {'Body': StreamingBody(io.BytesIO(value), len(value))}


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_paths_and_precise_time_reject_unsafe_inputs(self):
        for value in ['../x', '/x', 'a//x', 'a/./x', 'https://x', 'a\\x']:
            with self.assertRaises(ValueError):
                safe_path(value)
        for values in [[0, 0], [0, 0.5], [0, 2 ** 53]]:
            with self.assertRaises(ValueError):
                timestamps(values, 2, 'test')
        self.assertEqual(timestamps([0, 33_333_333], 2, 'test'), [0, 33_333_333])

    def test_csv_requires_unique_full_recording_id(self):
        path = self.root / 'index.csv'
        with path.open('w', encoding='utf-8-sig', newline='') as stream:
            w = csv.DictWriter(stream, ['recording_id', 'S3清单', '录制'])
            w.writeheader()
            w.writerow({'recording_id': 'abcdef', 'S3清单': 's3://b/r/manifest.json', '录制': 'example'})
        self.assertEqual(select_source(path, 'abcdef'), ('s3://b/r/manifest.json', 'example'))
        with self.assertRaises(ValueError):
            select_source(path, 'abc')
        path.write_text(path.read_text(encoding='utf-8-sig') + 'abcdef,s3://b/other/manifest.json,duplicate\n')
        with self.assertRaises(ValueError):
            select_source(path, 'abcdef')

    def test_receipt_limits_objects_to_its_directory(self):
        bad = {'files': [{'source_path': 'layer.json', 'object_key': 'other/layer.json', 'bytes': 0, 'sha256': '0' * 64}]}
        with self.assertRaises(ValueError):
            Receipt(MemoryS3({'r/manifest.json': json.dumps(bad).encode()}), 's3://b/r/manifest.json', self.root)
        wrong_recording = MemoryS3({'r/manifest.json': b'{"recording_id":"other", "files":[]} '})
        with self.assertRaisesRegex(ValueError, 'CSV 中的录制 ID'):
            Receipt(wrong_recording, 's3://b/r/manifest.json', self.root, 'selected')
        root_manifest = MemoryS3({'manifest.json': b'{"recording_id":"selected", "files":[]} '})
        self.assertEqual(Receipt(root_manifest, 's3://b/manifest.json', self.root, 'selected').prefix, '')

    def test_storage_config_uses_selected_profile_and_endpoint_override(self):
        config = self.root / 'storage.json'
        config.write_text(json.dumps({'profile': 'selected', 'profiles': {'selected': {
            'endpoint': 'https://storage.invalid', 'region': 'test-region',
            'access_key': 'test-access', 'secret_key': 'test-secret'}}}))
        with patch('boto3.client') as factory:
            storage_client(SimpleNamespace(storage_config=config, endpoint_url='https://override.invalid', addressing_style='virtual'))
        self.assertEqual(factory.call_args.kwargs['endpoint_url'], 'https://override.invalid')
        self.assertEqual(factory.call_args.kwargs['region_name'], 'test-region')
        self.assertEqual(factory.call_args.kwargs['aws_access_key_id'], 'test-access')

    def test_hash_mismatch_is_not_cached(self):
        receipt = {'files': [{'source_path': 'layer.json', 'object_key': 'r/layer.json', 'bytes': 3, 'sha256': '0' * 64}]}
        reader = Receipt(MemoryS3({'r/manifest.json': json.dumps(receipt).encode(), 'r/layer.json': b'bad'}), 's3://b/r/manifest.json', self.root)
        with self.assertRaises(ValueError):
            reader.get('layer.json')
        self.assertFalse((self.root / ('0' * 64)).exists())
        self.assertEqual(list(self.root.glob('*.part')), [])

    def test_failed_zip_verification_preserves_previous_output(self):
        payload = self.root / 'input.bin'
        payload.write_bytes(b'original')
        pack = Package()
        pack.add('data/input.bin', payload, 'test')
        output = self.root / 'existing.zip'
        output.write_bytes(b'previous output')
        payload.write_bytes(b'changed after checksum')
        with self.assertRaises(ValueError):
            pack.write(output, force=True)
        self.assertEqual(output.read_bytes(), b'previous output')
        self.assertEqual(list(self.root.glob('*.part')), [])

    def test_visualization_bundles_readme_model_motion_and_videos_with_exact_timing(self):
        def npz(**arrays):
            out = io.BytesIO()
            np.savez_compressed(out, **arrays)
            return out.getvalue()

        times = np.array([2 ** 40, 2 ** 40 + 33_333_333], dtype=np.int64)
        motion = {key: np.zeros((2, width), np.float32) for key, width in [
            ('global_orient', 3), ('body_pose', 63), ('jaw_pose', 3), ('leye_pose', 3),
            ('reye_pose', 3), ('left_hand_pose', 45), ('right_hand_pose', 45), ('transl', 3)]}
        motion.update(betas=np.zeros((1, 1), np.float32), expression=np.zeros((2, 1), np.float32),
                      reference_timestamps_ns=times, flat_hand_mean=np.array(True), use_pca=np.array(False),
                      coordinate_frame=np.array('synthetic'), units=np.array('m'))
        model = self.root / 'full-model.npz'
        shape = np.zeros((10475, 3, 302), np.float32)
        shape[0, 0, [0, 1, 300, 301]] = [2, 9, 3, 8]
        pose = np.zeros((10475, 3, 486), np.float32)
        pose[0, 0, 0] = 7
        parents = np.zeros((2, 55), np.int32)
        parents[0, 0] = -1
        model.write_bytes(npz(v_template=np.zeros((10475, 3), np.float32), shapedirs=shape, posedirs=pose,
                             J_regressor=np.zeros((55, 10475), np.float32), weights=np.zeros((10475, 55), np.float32),
                             kintree_table=parents, f=np.array([[0, 1, 2]], np.int32)))
        layer = {'recording_id': 'recording', 'version': 'result-display', 'world_frame': 'synthetic',
                 'units': 'm', 'frames': 2, 'body_observed_frames': 2, 'physical_accuracy_passed': False,
                 'parameters': 'motion.npz', 'preprocessing': 'pre.json', 'quality': 'quality.json',
                 'clock_id': 'clock', 'projections': [{'camera_id': 'cam', 'path': 'cam.mp4', 'frames': 2,
                                                      'image_size': [64, 64], 'video_pts_ns': [0, 33_333_333]}]}
        pre = {'time': {'reference_epoch_ns': 2 ** 60}, 'cameras': [{'camera_id': 'cam', 'kind': 'ego',
               'T_world_from_camera': np.eye(4).tolist(), 'pose_valid': [True, True]}]}
        data = {'layer.json': json.dumps(layer).encode(), 'pre.json': json.dumps(pre).encode(),
                'quality.json': b'{"physical_accuracy_passed": false}', 'motion.npz': npz(**motion),
                'cam.mp4': b'synthetic-container-placeholder',
                'cam-source-frames.npz': npz(reference_timestamps_ns=times, source_observed=np.array([0, 1])),
                'cam-source.json': json.dumps({'calibration': {'K': [[50, 0, 32], [0, 50, 32], [0, 0, 1]], 'image_size': [64, 64]}}).encode()}
        files = []
        for name, value in data.items():
            p = self.root / name
            p.write_bytes(value)
            files.append({'source_path': name, 'object_key': 'r/' + name, 'bytes': len(value), 'sha256': digest(p)})
        manifest = {'recording_id': 'recording', 'published': {'state': 'succeeded', 'raw_smplx': 'layer.json', 'version': 'result'}, 'files': files}
        client = MemoryS3({'r/manifest.json': json.dumps(manifest).encode(), **{'r/' + k: v for k, v in data.items()}})
        reader = Receipt(client, 's3://bucket/r/manifest.json', self.root / 'cache')
        args = SimpleNamespace(model=model, output=self.root / 'out.zip', manifest='s3://bucket/r/manifest.json', force=False)
        report = build(args, reader, self.root)
        self.assertFalse(report['physical_accuracy_passed'])
        self.assertEqual(report['cameras'], ['EGO01'])
        with zipfile.ZipFile(args.output) as archive:
            self.assertEqual(sorted(archive.namelist()), ['README.md', 'models/smplx.npz', 'motions/subject_01/smplx_parameters.npz', 'videos/ego01.mp4'])
            self.assertEqual(archive.read('videos/ego01.mp4'), data['cam.mp4'])
            readme = archive.read('README.md').decode('utf-8')
            for value in ['recording', 'result', 'models/smplx.npz', 'ego01.mp4', '未通过', '无需另行导入']:
                self.assertIn(value, readme)
            self.assertNotIn('s3://', readme)
            with np.load(io.BytesIO(archive.read('models/smplx.npz')), allow_pickle=False) as packed:
                self.assertEqual(packed['shapedirs'].shape, (10475, 3, 301))
                self.assertEqual(packed['shapedirs'][0, 0, 0], 2)
                self.assertEqual(packed['shapedirs'][0, 0, 1], 0)
                self.assertEqual(packed['shapedirs'][0, 0, 300], 3)
                self.assertEqual(packed['posedirs'][0, 0, 0], 7)
            with np.load(io.BytesIO(archive.read('motions/subject_01/smplx_parameters.npz')), allow_pickle=False) as params:
                metadata = json.loads(params['preview_metadata'].item())
                import hashlib
                self.assertEqual(metadata['model']['sha256'], hashlib.sha256(archive.read('models/smplx.npz')).hexdigest())
                self.assertEqual(metadata['model']['source_sha256'], digest(model))
                self.assertEqual(params['source_model_sha256'].item(), digest(model))
                self.assertEqual(metadata['model']['bytes'], archive.getinfo('models/smplx.npz').file_size)
                self.assertEqual(params['reference_timestamps_ns'].tolist(), times.tolist())
                self.assertEqual(params['preview_video_pts_ns'].tolist(), [[0, 33_333_333]])
                self.assertEqual(params['preview_source_observed'].tolist(), [[False, True]])
                self.assertEqual(params['body_observed'].tolist(), [True, True])
                self.assertFalse(metadata['physical_accuracy_passed'])
                for key in motion:
                    np.testing.assert_array_equal(params[key], motion[key])
                self.assertNotIn('source_manifest', metadata)
                self.assertNotIn('calibration', metadata)
                self.assertEqual(params['betas'][0, 0], 0)
        reads = len(client.reads)
        reader.get('motion.npz')
        self.assertEqual(len(client.reads), reads)
        previous_hash = report['sha256']
        args.force = True
        self.assertEqual(build(args, reader, self.root)['sha256'], previous_hash)
        layer['body_observed_frames'] = 1
        reader.json = lambda path: layer if path == 'layer.json' else pre
        with self.assertRaisesRegex(ValueError, '逐帧人体观测'):
            build(args, reader, self.root)


if __name__ == '__main__':
    unittest.main()
