#!/usr/bin/env python3
"""Prepare the static model used when a visualization ZIP omits its model."""
import argparse
import json
import os
from pathlib import Path
import tempfile

from package_recording import digest, require, validate_model, write_playback_model


def prepare_model(source, destination, betas=300, expressions=100):
    require(1 <= betas <= 300 and 1 <= expressions <= 100, '模型参数维数无效')
    source_sha = validate_model(source, betas, expressions, False)
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination, prefix='.prepare-') as directory:
        temporary = Path(directory)
        model = temporary / 'model.npz'
        sha = write_playback_model(source, model, betas, expressions, False)
        validate_model(model, betas, expressions, False)
        filename = f'smplx-{sha}.npz'
        metadata = dict(format='synaexo-default-model', schema_version=1, file=filename,
                        sha256=sha, source_sha256=source_sha, bytes=model.stat().st_size,
                        num_betas=betas, num_expression=expressions)
        require(metadata['bytes'] <= 256 * 1024**2, '内置模型超过浏览器读取预算')
        catalog = temporary / 'default.json'
        catalog.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        target = destination / filename
        if target.exists():
            require(digest(target) == sha, f'同名模型已损坏，未覆盖：{target}')
        else:
            os.replace(model, target)
        os.replace(catalog, destination / 'default.json')
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='从完整 SMPL-X 源模型生成预览器内置静态模型与校验清单')
    parser.add_argument('--model', required=True, type=Path, help='已获授权的完整模型 NPZ')
    parser.add_argument('--output-dir', type=Path, default=Path('public/models'), help='静态资源目录，默认 public/models')
    parser.add_argument('--num-betas', type=int, default=300)
    parser.add_argument('--num-expression', type=int, default=100)
    args = parser.parse_args()
    try:
        result = prepare_model(args.model, args.output_dir, args.num_betas, args.num_expression)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f'prepare_viewer_model: 模型准备失败：{error}\n')
