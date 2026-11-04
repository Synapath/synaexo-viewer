import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import zipfile

import numpy as np

from delivery_bundle import DeliveryPlan
from package_recording import Receipt, build, digest, publish_delivery
from test_package_recording import MemoryS3


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode()


class DeliveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def fixture(self, missing=None, conflicting_observations=False):
        times = np.array([10**12, 10**12 + 40_000_001, 10**12 + 80_000_003], dtype=np.int64)
        prefix = 'results/run/'
        layer_path = prefix + 'motions/humans/person/manifest.json'
        parameter_path = prefix + 'motions/humans/person/smplx-parameters.npz'
        out = io.BytesIO()
        np.savez_compressed(out, reference_timestamps_ns=times, coordinate_frame=np.array('world'), units=np.array('m'),
                            body_observed=np.array([True, False, True]), body_pose=np.zeros((3, 63), np.float32))
        parameters = out.getvalue()
        data = {parameter_path: parameters, prefix + 'motions/humans/person/quality.json': b'{"physical_accuracy_passed": false}'}
        layer = dict(recording_id='recording', source_recording_id='source', version='run',
                     parameters=parameter_path, quality=prefix + 'motions/humans/person/quality.json',
                     preprocessing=prefix + 'preprocessing.json', clock_id='clock', world_frame='world', units='m',
                     frames=3, body_observed_frames=2, physical_accuracy_passed=False)
        if conflicting_observations:
            observed = io.BytesIO()
            np.savez_compressed(observed, reference_timestamps_ns=times, body_observed=np.array([False, True, True]))
            layer['observations'] = prefix + 'motions/humans/person/observations.npz'
            data[layer['observations']] = observed.getvalue()
        data[layer_path] = encoded(layer)
        data[layer['preprocessing']] = encoded({'cameras': [{'camera_id': 'cam', 'kind': 'gopro'}, {'camera_id': 'ego-device', 'kind': 'ego'}]})
        data[prefix + 'timeline/clock_models.json'] = encoded(dict(clock_id='clock', reference_epoch_ns=2**60,
                                                                 models={cid: dict(scale=1, offset_ns=0, reference_clock_id='clock')
                                                                         for cid in ['cam', 'ego-device']}))
        data[prefix + 'timeline/quality.json'] = b'{"physical_accuracy_passed": false}'
        intrinsic = dict(camera_matrix=[[50, 0, 32], [0, 50, 32], [0, 0, 1]], image_size=[64, 64],
                         dist_coeffs=[0, 0, 0, 0], distortion_model='opencv_fisheye')
        calibrations = {
            'calibration/frozen/gopro/cam/intrinsics.json': encoded({'intrinsics': intrinsic}),
            'calibration/frozen/ego/device/intrinsics.json': encoded({'eyes': {'left': intrinsic, 'right': intrinsic}}),
            'calibration/frozen/ego/device/extrinsics.json': encoded({'stereo': dict(
                R_right_from_left=np.eye(3).tolist(), t_right_from_left_m=[0.1, 0, 0], direction='left_to_right', baseline_m=0.1)})}
        originals = [dict(path='raw/gopro/cam/a/first.MP4', device_type='gopro', device_id='cam', asset_id='a',
                          source_filename='first.MP4', segment_index=0),
                     dict(path='raw/gopro/cam/b/second.MP4', device_type='gopro', device_id='cam', asset_id='b',
                          source_filename='second.MP4', segment_index=1),
                     dict(path='raw/ego/device/stereo/stereo.mp4', device_type='ego', device_id='device', asset_id='stereo',
                          source_filename='stereo.mp4', layout='side_by_side', eye_order='right_left', slot='stereo')]
        raw = {v['path']: ('original:' + v['path']).encode() for v in originals}
        for cid in ['cam', 'ego-device']:
            poses = prefix + f'trajectories/cameras/{cid}/extrinsics.jsonl'
            rows = [dict(reference_frame_index=i, reference_time_ns=int(t), valid=i != 1,
                         transform_matrix=np.eye(4).tolist() if i != 1 else None) for i, t in enumerate(times)]
            data[poses] = b'\n'.join(encoded(row) for row in rows) + b'\n'
            data[poses.removesuffix('extrinsics.jsonl') + 'manifest.json'] = encoded(dict(
                stream_id=cid, source_frame=cid + '/camera_optical', target_frame='world', transform_direction='camera_to_world',
                translation_units='m', reference_epoch_ns=2**60, mode='static_initialization', sample_count=3, valid_sample_count=2,
                file=dict(path='extrinsics.jsonl', size_bytes=len(data[poses]), sha256=hashlib.sha256(data[poses]).hexdigest())))
            table = io.StringIO(newline='')
            writer = csv.writer(table)
            writer.writerow(['reference_frame_index', 'reference_time_ns', 'source_frame_index', 'source_time_ns', 'valid'])
            writer.writerow([0, int(times[0]), 0, 0, 'true'])
            writer.writerow([1, int(times[1]), 2, 100_000_000, 'true'])
            writer.writerow([2, int(times[2]), '', '', 'false'])
            data[prefix + f'timeline/frame_mapping/{cid}.csv'] = table.getvalue().encode()
        data[prefix + 'timeline/evidence/cam-chapters.json'] = encoded(dict(ordered_sources=[
            dict(first_joined_index=0, frames=2, pts_offset_ns=0, sha256=hashlib.sha256(raw[originals[0]['path']]).hexdigest()),
            dict(first_joined_index=2, frames=2, pts_offset_ns=100_000_000, sha256=hashlib.sha256(raw[originals[1]['path']]).hexdigest())]))
        data['previews/run/overlays/cam.mp4'] = b'baked-video-must-not-become-original'
        data['previews/run/replay/recording.rrd'] = b'not-exported'
        raw['raw/tracker/capture/poses.jsonl'] = b'not-exported'
        if missing:
            data.pop(missing, None)
            calibrations.pop(missing, None)
            raw.pop(missing, None)
            originals = [v for v in originals if v['path'] != missing]
        def entry(path, payload):
            return dict(path=path, size_bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        root = dict(format='synaexo_recording', schema_version=1, recording_id='recording', source_recording_id='source',
                    files=[{**entry(v['path'], raw[v['path']]), **v} for v in originals]
                    + [entry(p, b) for p, b in calibrations.items()] + [entry('raw/tracker/capture/poses.jsonl', b'not-exported')])
        root_bytes = encoded(root)
        doc = dict(format='synaexo_result', schema_version=1, recording_id='recording', source_recording_id='source', result_id='run',
                   recording_manifest=entry('manifest.json', root_bytes), files=[entry(p, b) for p, b in data.items()],
                   calibration_files=[entry(p, b) for p, b in calibrations.items()])
        objects = {'r/results/run/manifest.json': encoded(doc), 'r/manifest.json': root_bytes,
                   **{'r/' + p: b for p, b in {**data, **raw, **calibrations}.items()}}
        client = MemoryS3(objects)
        receipt = Receipt(client, 's3://bucket/r/results/run/manifest.json', self.root / 'cache')
        report = dict(recording_id='source', result_id='run', source_parameters_sha256=hashlib.sha256(parameters).hexdigest(),
                      source_model_sha256='1' * 64, physical_accuracy_passed=False)
        return receipt, report, client, parameters, raw

    def parameter_fixture(self):
        receipt, _, client, _, originals = self.fixture()
        objects = client.objects
        prefix = 'results/run/'
        layer_path = prefix + 'motions/humans/person/manifest.json'
        layer = json.loads(objects['r/' + layer_path])
        times = np.array([10**12,10**12+40_000_001,10**12+80_000_003],np.int64)
        parents = np.zeros((2,55),np.int32); parents[0,0] = -1
        weights = np.zeros((10475,55),np.float32); weights[:,0] = 1
        model = self.root/'model.npz'
        template = np.zeros((10475,3),np.float32)
        template[:3] = [[-.4,-.5,3],[.4,-.5,3],[0,.5,3]]
        np.savez_compressed(model,v_template=template,shapedirs=np.zeros((10475,3,10),np.float32),
            posedirs=np.zeros((10475,3,486),np.float32),J_regressor=np.zeros((55,10475),np.float32),
            kintree_table=parents,weights=weights,f=np.array([[0,1,2]],np.int32))
        data = dict(reference_timestamps_ns=times,units=np.array('m'),coordinate_frame=np.array('world'),
            flat_hand_mean=np.array(True),use_pca=np.array(False),model_sha256=np.array(digest(model)),
            betas=np.zeros((1,10),np.float32),transl=np.zeros((3,3),np.float32),
            joint_rotations=np.broadcast_to(np.eye(3,dtype=np.float32),(3,55,3,3)),
            body_observed=np.array([True,False,True]),hand_accepted=np.array([[True,False],[False,False],[True,True]]),
            hand_view_count=np.array([[2,0],[0,0],[3,4]],np.int64))
        def npz(**values):
            out=io.BytesIO();np.savez_compressed(out,**values);return out.getvalue()
        original_parameters=npz(**data)
        objects['r/'+layer['parameters']]=original_parameters
        cameras=[]
        for cid,kind in [('cam','gopro'),('ego-device','ego')]:
            mapping=prefix+f'timeline/evidence/{cid}-source-frames.npz'
            objects['r/'+mapping]=npz(reference_timestamps_ns=times,source_observed=np.array([True,True,False]))
            path=f'previews/run/parameter-proxies/{cid}.mp4'
            objects['r/'+path]=('proxy:'+cid).encode()
            cameras.append(dict(camera_id=cid,kind=kind,frame_map=mapping,
                calibration=dict(K=[[50,0,32],[0,50,32],[0,0,1]],image_size=[64,64]),
                T_world_from_camera=np.eye(4).tolist(),pose_valid=[True,False,True],
                proxy=dict(path=path,image_size=[32,32],video_pts_ns=[0,40_000_001,80_000_003])))
        recipe_path='previews/run/parameter-proxies/manifest.json'
        recipe=dict(format='synaexo-parameter-preview-v1',recording_id='recording',source_recording_id='source',
            clock_id='clock',world_frame='world',parameters=layer['parameters'],cameras=cameras,
            model=dict(model_sha256=digest(model),frames=3,max_abs_vertex_error_m=1e-7,max_allowed_error_m=.00002))
        objects['r/'+recipe_path]=encoded(recipe)
        layer.update(delivery_profile='parameters',preview=recipe_path)
        objects['r/'+layer_path]=encoded(layer)
        doc=receipt.document.copy()
        doc['files']=[dict(path=key[2:],size_bytes=len(value),sha256=hashlib.sha256(value).hexdigest())
                      for key,value in objects.items() if key.startswith(('r/results/run/','r/previews/run/')) and not key.endswith('results/run/manifest.json')]
        objects['r/results/run/manifest.json']=encoded(doc)
        receipt=Receipt(client,'s3://bucket/r/results/run/manifest.json',self.root/'parameter-cache')
        return receipt,model,client,original_parameters,originals

    def test_final_matrices_jointly_export_without_baked_videos_or_parameter_rewriting(self):
        receipt,model,client,original_parameters,originals=self.parameter_fixture()
        stage=self.root/'joint';stage.mkdir();scratch=self.root/'scratch';scratch.mkdir()
        output=self.root/'exports';output.mkdir()
        args=SimpleNamespace(model=model,output=stage/'visualization.zip',force=False,
                             output_dir=output,manifest='s3://bucket/r/results/run/manifest.json',delivery_plan=DeliveryPlan(receipt))
        report=build(args,receipt,scratch)
        result=publish_delivery(args,receipt,report,stage)
        delivery=Path(result['delivery']);archive=Path(result['archive'])
        self.assertEqual((delivery/'motions/subject_01/smplx_parameters.npz').read_bytes(),original_parameters)
        self.assertEqual(archive.name,'syanexo-'+digest(archive)+'.zip')
        with zipfile.ZipFile(archive) as z:
            self.assertEqual({n.split('/')[0] for n in z.namelist()},{'README.md','models','motions','videos'})
            self.assertEqual(z.read('models/smplx.npz'),model.read_bytes())
            self.assertEqual(z.read('videos/exo01.mp4'),client.objects['r/previews/run/parameter-proxies/cam.mp4'])
            self.assertIn('未烘焙 SMPL-X',z.read('README.md').decode())
            with np.load(io.BytesIO(z.read('motions/subject_01/smplx_parameters.npz'))) as motion, np.load(io.BytesIO(original_parameters)) as original:
                for key in original.files:np.testing.assert_array_equal(motion[key],original[key])
                meta=json.loads(str(motion['preview_metadata']))
                self.assertEqual(meta['representation'],'smplx_local_rotations')
                self.assertEqual(meta['model']['sha256'],digest(model))
                self.assertEqual(meta['model']['num_expression'],0)
                self.assertEqual([v['content'] for v in meta['videos']],['clean_proxy','clean_proxy'])
                self.assertEqual(motion['preview_camera_0_K'][0,0],25)
                self.assertEqual(motion['preview_camera_0_pose_valid'].tolist(),[True,False,True])
                self.assertEqual(motion['preview_source_observed'].tolist(),[[True,True,False]]*2)
        self.assertNotIn('r/previews/run/overlays/cam.mp4',client.reads)
        for name,value in originals.items():
            if '/tracker/' not in name:self.assertEqual((delivery/name.replace('raw/','videos/',1)).read_bytes(),value)

    def publish(self, receipt, report, label='stage'):
        stage = self.root / label
        stage.mkdir()
        archive = stage / 'visualization.zip'
        archive.write_bytes(b'visualization-validated-separately')
        report = {**report, 'sha256': digest(archive)}
        output = self.root / 'exports'
        output.mkdir(exist_ok=True)
        args = SimpleNamespace(output=archive, output_dir=output, delivery_plan=DeliveryPlan(receipt))
        return publish_delivery(args, receipt, report, stage)

    def test_complete_delivery_retains_originals_and_maps_actual_chapters(self):
        receipt, report, client, parameters, originals = self.fixture()
        result = self.publish(receipt, report)
        delivery = Path(result['delivery'])
        manifest = json.loads((delivery / 'manifest.json').read_text())
        self.assertEqual(manifest['delivery_version'], '1.0.0')
        self.assertEqual(manifest['source_recording_id'], 'source')
        self.assertFalse(manifest['physical_accuracy_passed'])
        self.assertEqual((delivery / 'motions/subject_01/smplx_parameters.npz').read_bytes(), parameters)
        for original, payload in originals.items():
            target = delivery / original.replace('raw/', 'videos/', 1)
            if '/tracker/' in original:
                self.assertFalse(target.exists())
                self.assertNotIn('r/' + original, client.reads)
            else:
                self.assertEqual(target.read_bytes(), payload)
        for item in manifest['files']:
            self.assertEqual(digest(delivery / item['path']), item['sha256'])
        with (delivery / 'timeline/frame_mapping/cam.csv').open() as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(rows[1]['source_video'], 'videos/gopro/cam/b/second.MP4')
        self.assertEqual(rows[1]['source_frame_index'], '0')
        self.assertEqual(rows[1]['source_time_ns'], '0')
        self.assertEqual(rows[1]['joined_source_frame_index'], '2')
        self.assertEqual(rows[2]['source_video'], '')
        reference = json.loads((delivery / 'timeline/reference.json').read_text())
        self.assertEqual(reference['reference_epoch_ns'], str(2**60))
        self.assertEqual(len(manifest['cameras']), 2)
        self.assertEqual(manifest['cameras'][1]['videos'][0]['eye_order'], 'right_left')
        self.assertNotIn('r/previews/run/overlays/cam.mp4', client.reads)
        self.assertNotIn('r/previews/run/replay/recording.rrd', client.reads)
        repeated = self.publish(receipt, report, 'retry')
        self.assertEqual(result['directory'], repeated['directory'])
        (delivery / 'README.md').write_text('user changes')
        with self.assertRaisesRegex(ValueError, '未覆盖'):
            self.publish(receipt, report, 'modified')

    def test_missing_intrinsics_world_extrinsics_or_stereo_cannot_pass_as_complete(self):
        for missing in ['calibration/frozen/gopro/cam/intrinsics.json',
                        'calibration/frozen/ego/device/extrinsics.json',
                        'results/run/trajectories/cameras/cam/extrinsics.jsonl',
                        'results/run/timeline/frame_mapping/ego-device.csv']:
            with self.subTest(missing=missing):
                receipt, *_ = self.fixture(missing)
                with self.assertRaises(ValueError):
                    DeliveryPlan(receipt)

    def test_corrupt_original_or_mismatched_run_does_not_publish_half_delivery(self):
        receipt, report, client, *_ = self.fixture()
        with self.assertRaisesRegex(ValueError, '不一致'):
            self.publish(receipt, {**report, 'result_id': 'other'}, 'wrong-run')
        client.objects['r/raw/gopro/cam/a/first.MP4'] = b'corrupted'
        with self.assertRaisesRegex(ValueError, '摘要不匹配'):
            self.publish(receipt, report, 'bad-original')
        self.assertEqual(list((self.root / 'exports').iterdir()), [])
        self.assertEqual(list((self.root / 'cache').glob('*.part')), [])

    def test_conflicting_observations_cannot_override_the_motion_mask(self):
        receipt, report, *_ = self.fixture(conflicting_observations=True)
        with self.assertRaisesRegex(ValueError, '人体有效性不一致'):
            self.publish(receipt, report)
        self.assertEqual(list((self.root / 'exports').iterdir()), [])

    def test_standard_receipt_rejects_other_run_and_legacy_cannot_export_incomplete_data(self):
        client = MemoryS3({'r/manifest.json': b'{"files": []}'})
        legacy = Receipt(client, 's3://bucket/r/manifest.json', self.root / 'cache')
        with self.assertRaisesRegex(ValueError, 'result-manifest'):
            DeliveryPlan(legacy)
        receipt, *_ = self.fixture()
        doc = dict(receipt.document)
        doc['files'] = [dict(path='results/other/secret.npz', size_bytes=1, sha256='0' * 64)]
        bad = MemoryS3({'r/results/run/manifest.json': encoded(doc)})
        with self.assertRaisesRegex(ValueError, '其他 run'):
            Receipt(bad, 's3://bucket/r/results/run/manifest.json', self.root / 'cache')


if __name__ == '__main__':
    unittest.main()
