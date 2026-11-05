from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from package_recording import digest, main, update_index
from test_package_recording import MemoryS3


class PackageIndexTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.output = self.root / 'exports'
        self.report = dict(recording_id='recording', result_id='run')
        self.client = MemoryS3({'r/manifest.json': b'{"recording_id":"recording","files":[]}'})

    def build_zip(self, args, *_):
        # ZIP content validation is covered by PackagingTests; these cases exercise publication and indexing.
        args.output.write_bytes(('validated ZIP: ' + self.report['result_id']).encode())
        return {**self.report, 'archive': str(args.output), 'sha256': digest(args.output)}

    def invoke(self, *options, fail=False, builder=None):
        source = [] if '--csv' in options or '--manifest' in options else ['--manifest', 's3://bucket/r/manifest.json']
        argv = ['package_recording.py', *source, '--model', str(self.root / 'model.npz'),
                '--output-dir', str(self.output), '--cache-dir', str(self.root / 'cache'), *options]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('sys.argv', argv), patch('package_recording.storage_client', return_value=self.client), \
                patch('package_recording.build', side_effect=builder or self.build_zip), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            if fail:
                with self.assertRaises(SystemExit) as error:
                    main()
                self.assertEqual(error.exception.code, 1)
            else:
                main()
        return (json.loads(stdout.getvalue()) if stdout.getvalue() else None), stderr.getvalue()

    def rows(self):
        with (self.output / 'synaexo-index.csv').open(encoding='utf-8-sig', newline='') as stream:
            return list(csv.DictReader(stream))

    def test_cli_accumulates_csv_names_and_runs_and_updates_retries_without_changing_zip(self):
        source = self.root / 'source.csv'
        name = 'Tracker 11, "拣选"\n复测'
        with source.open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow(['recording_id', 'S3清单', '录制'])
            writer.writerow(['recording', 's3://bucket/r/manifest.json', name])
        report, stderr = self.invoke('--csv', str(source), '--recording-id', 'recording')
        self.assertEqual(stderr, '')
        self.assertEqual(report['recording_name'], name)
        self.assertEqual(report['index'], str(self.output / 'synaexo-index.csv'))
        self.assertTrue(Path(report['index']).read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertEqual(self.rows(), [{'录制名称': name, '录制ID': 'recording', 'run ID': 'run',
                                      'ZIP文件名': Path(report['archive']).name}])
        repeated, _ = self.invoke('--csv', str(source), '--recording-id', 'recording', '--recording-name', '新名称')
        self.assertEqual(repeated['sha256'], report['sha256'])
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['录制名称'], '新名称')
        self.report['result_id'] = 'run-2'
        self.invoke('--csv', str(source), '--recording-id', 'recording')
        self.assertEqual([r['run ID'] for r in self.rows()], ['run', 'run-2'])
        self.assertEqual(len(list(self.output.glob('*.zip'))), 2)

    def test_standard_manifest_reads_name_only_from_verified_matching_recording(self):
        def entry(path, payload):
            return dict(path=path, size_bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
        root = dict(format='synaexo_recording', schema_version=1, recording_id='recording',
                    source_recording_id='source', name='标准录制名称')
        for identity in ['recording', 'other']:
            root_bytes = json.dumps({**root, 'recording_id': identity}).encode()
            result = dict(format='synaexo_result', schema_version=1, recording_id='recording',
                          source_recording_id='source', result_id='run',
                          recording_manifest=entry('manifest.json', root_bytes),
                          files=[entry('results/run/motions/humans/person/manifest.json', b'{}')])
            self.client.objects.update({'r/results/run/manifest.json': json.dumps(result).encode(),
                                        'r/manifest.json': root_bytes})
            report, stderr = self.invoke('--manifest', 's3://bucket/r/results/run/manifest.json',
                                         fail=identity != 'recording')
            if report:
                self.assertEqual(report['recording_name'], '标准录制名称')
            else:
                self.assertIn('录制清单与所选结果身份不一致', stderr)
        self.assertEqual(len(self.rows()), 1)

    def test_unnamed_legacy_receipt_leaves_name_blank_and_keeps_stdout_json(self):
        report, stderr = self.invoke()
        self.assertEqual(report['recording_name'], '')
        self.assertEqual(self.rows()[0]['录制名称'], '')
        self.assertIn('--recording-name', stderr)

    def test_failed_build_does_not_change_index_or_publish_a_new_zip(self):
        self.invoke('--recording-name', '已有录制')
        before = (self.output / 'synaexo-index.csv').read_bytes()
        self.report['result_id'] = 'failed-run'
        def fail(*_):
            raise ValueError('synthetic source mismatch')
        _, stderr = self.invoke('--recording-name', '失败录制', fail=True, builder=fail)
        self.assertIn('synthetic source mismatch', stderr)
        self.assertEqual((self.output / 'synaexo-index.csv').read_bytes(), before)
        self.assertEqual(len(list(self.output.glob('*.zip'))), 1)

    def test_index_failure_preserves_previous_content_and_reports_published_zip(self):
        self.output.mkdir()
        target = self.output / 'synaexo-index.csv'
        target.write_text('user-owned-content')
        _, stderr = self.invoke('--recording-name', '待索引录制', fail=True)
        self.assertIn('ZIP 已生成：', stderr)
        self.assertIn('索引更新失败', stderr)
        self.assertEqual(target.read_text(), 'user-owned-content')
        self.assertEqual(len(list(self.output.glob('*.zip'))), 1)
        target.unlink()
        report, _ = self.invoke('--recording-name', '待索引录制')
        before = target.read_bytes()
        with patch('package_recording.os.replace', side_effect=OSError('synthetic write failure')):
            with self.assertRaises(OSError):
                update_index(self.output, {**report, 'recording_name': '新名称'})
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(list(self.output.glob('*.part')), [])

    def test_concurrent_exports_retain_every_archive(self):
        self.output.mkdir()
        reports = []
        for i in range(8):
            archive = self.output / f'archive-{i}.zip'
            archive.write_bytes(b'validated')
            reports.append(dict(recording_name=f'录制 {i}', recording_id=f'recording-{i}',
                                result_id=f'run-{i}', archive=str(archive)))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda report: update_index(self.output, report), reports + reports))
        self.assertEqual(len(self.rows()), len(reports))
        self.assertEqual({r['ZIP文件名'] for r in self.rows()}, {Path(r['archive']).name for r in reports})


if __name__ == '__main__':
    unittest.main()
