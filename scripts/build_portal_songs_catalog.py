"""Build the portal's song catalogue, and (opt-in only) the static lyric assets.

What the portal reads at runtime
--------------------------------
Nothing this script writes. The runtime song index comes from D1
(`source_variants` for the active assets release) and the counts from the
release's own `release_summaries` row; `public/data/songs_catalog.json`,
`src/songs_catalog.js` and `public/data/lyrics/*.json` are build products of
this pipeline, not portal inputs. `public/.assetsignore` excludes the ones that
would otherwise be published as static assets.

The static lyric assets are retired
-----------------------------------
`public/data/lyrics/<bundle>.json` was a per-song source cache. The Worker's
runtime fallback to it was removed (`src/worker.js` no longer reads it) and
`public/app.js` refuses a static fallback outright, because serving that file
let an offline extractor snapshot overrule the release that is live now. The
files that already exist under `public/data/lyrics/` are therefore unreferenced
but deliberately NOT deleted (they are regenerable pipeline evidence; see
work/agents/text-localization/static-lyrics-retirement-20260929/HANDOFF.md).

Emitting new ones is now opt-in: pass ``--write-static-lyrics``. Without the
flag the catalogue is built and the lyric directory is left exactly as it is.
"""
import argparse
import glob
import json
import os
import sys

# The portal consumes the asset-server localization repository (locales/ + lyrics/).
# Keep this as the default so existing invocations still work; --repo-root lets the
# same builder run against a freshly exported checkout elsewhere.
DEFAULT_REPO_ROOT = 'build/runs/text-localization/9.0.200/github-export-candidate'
REPO_ROOT = DEFAULT_REPO_ROOT
LYRICS_DIR = os.path.join(REPO_ROOT, 'lyrics')
PORTAL_DIR = 'web/translation-portal'
LYRIC_ASSET_DIR = os.path.join(PORTAL_DIR, 'public', 'data', 'lyrics')
DEFAULT_ASSET_VERSION = os.environ.get('PORTAL_DEFAULT_ASSET_VERSION', '1077100')


def set_repo_root(path):
    """Point every reader at another localization-repository checkout."""
    global REPO_ROOT, LYRICS_DIR
    REPO_ROOT = path
    LYRICS_DIR = os.path.join(REPO_ROOT, 'lyrics')


def build_lyric_assets(asset_version=DEFAULT_ASSET_VERSION):
    """Emit one static JSON per song. Retired — reachable only via --write-static-lyrics.

    The docstring used to say this existed "so the portal serves lyric tracks
    with 0 D1 reads". That is no longer true and is now the reason not to run it:
    nothing serves these files, and a file on disk that looks like a release is a
    source the release does not carry. Kept because the emission is the only
    producer of the 432 existing files, and an operator must be able to say
    explicitly that they want it.
    """
    os.makedirs(LYRIC_ASSET_DIR, exist_ok=True)
    written = 0
    total_lines = 0

    for song_path in sorted(glob.glob(os.path.join(LYRICS_DIR, 'songs', '*.jsonl'))):
        bundle = os.path.basename(song_path)[:-len('.jsonl')]
        lines = []
        with open(song_path, 'r', encoding='utf-8') as sf:
            for row in map(json.loads, sf):
                lines.append({
                    'slot_index': len(lines) + 1,
                    'item_key': str(row.get('index', '')),
                    'source': row.get('ja', ''),
                    'translation': row.get('zh') or None,
                    'status': row.get('status') or 'untranslated',
                    'source_sha256': row.get('source_sha256', ''),
                    'bundle': bundle,
                    'asset_version': asset_version,
                    'base_version': asset_version,
                })
        if not lines:
            continue
        with open(os.path.join(LYRIC_ASSET_DIR, f'{bundle}.json'), 'w', encoding='utf-8') as out:
            json.dump(lines, out, ensure_ascii=False)
        written += 1
        total_lines += len(lines)

    return written, total_lines


def main():
    parser = argparse.ArgumentParser(description=__doc__ or 'Build the portal song catalogue')
    parser.add_argument(
        '--repo-root',
        default=DEFAULT_REPO_ROOT,
        help='Localization repository checkout to read locales/ and lyrics/ from',
    )
    parser.add_argument(
        '--asset-version',
        default=DEFAULT_ASSET_VERSION,
        help=f'Asset version for lyric tracks (default: {DEFAULT_ASSET_VERSION})',
    )
    parser.add_argument(
        '--write-static-lyrics',
        action='store_true',
        help=(
            f'Also write the retired per-song lyric snapshots into {LYRIC_ASSET_DIR} '
            '(one JSON per song). Off by default: nothing reads them at runtime, and '
            'rewriting them re-authorises an offline snapshot the release does not '
            'carry. Pass this only to regenerate that evidence deliberately.'
        ),
    )
    args = parser.parse_args()
    set_repo_root(args.repo_root)

    # 1. Read catalog
    with open('build/current-catalog-source.json', 'r', encoding='utf-8', errors='ignore') as f:
        cat = json.load(f)

    # 2. Read MD song names
    md_songs = {}
    md_path = os.path.join(REPO_ROOT, 'locales', 'master', 'MD_jp.gtx.jsonl')
    with open(md_path, 'r', encoding='utf-8') as f:
        for line in f:
            row = json.loads(line)
            k = row.get('item_key', '')
            if k.startswith('ld_song_name_') and not k.startswith('ld_song_name_phonetic_'):
                try:
                    sid = int(k.replace('ld_song_name_', ''))
                    md_songs[sid] = {'ja': row.get('ja', ''), 'zh': row.get('zh', '')}
                except:
                    pass

    catalog_songs = cat.get('mltdapp', {}).get('songs', [])
    asset_to_info = {}
    for s in catalog_songs:
        asset = s.get('asset', '').lower()
        name = s.get('song_name', '').strip()
        mst_id = s.get('mst_song_id')
        stype = s.get('song_type', 4) # 1: Princess, 2: Fairy, 3: Angel, 4: All
        type_str = 'Princess' if stype == 1 else 'Fairy' if stype == 2 else 'Angel' if stype == 3 else 'All'

        ja_name = name
        zh_name = ''
        if mst_id in md_songs:
            ja_name = md_songs[mst_id]['ja']
            zh_name = md_songs[mst_id]['zh']

        asset_to_info[asset] = {
            'name_ja': ja_name,
            'name_zh': zh_name or ja_name,
            'mst_song_id': mst_id,
            'song_type': type_str,
            'bpm': s.get('bpm_max', 170)
        }

    # 3. Read lyrics manifest
    manifest_path = os.path.join(REPO_ROOT, 'lyrics', 'lyrics_manifest.json')
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)

    songs_list = []
    total_slots = 0
    total_translated = 0

    for s in manifest.get('songs', []):
        bundle = s['bundle']
        asset = bundle.replace('scrobj_', '').replace('.unity3d', '').lower()
        info = asset_to_info.get(asset, {
            'name_ja': asset,
            'name_zh': asset,
            'mst_song_id': 0,
            'song_type': 'All',
            'bpm': 170
        })

        # Read first line preview from lyrics/songs/{bundle}.jsonl
        preview_ja = ''
        preview_zh = ''
        song_path = os.path.join(LYRICS_DIR, 'songs', f'{bundle}.jsonl')
        try:
            with open(song_path, 'r', encoding='utf-8') as sf:
                first_line = sf.readline()
                if first_line:
                    f_row = json.loads(first_line)
                    preview_ja = f_row.get('ja', '')
                    preview_zh = f_row.get('zh', '')
        except Exception as e:
            pass

        slots = s.get('slots', 0)
        translated = s.get('translated', slots)
        total_slots += slots
        total_translated += translated

        songs_list.append({
            'bundle': bundle,
            'asset': asset,
            'name_ja': info['name_ja'],
            'name_zh': info['name_zh'],
            'type': info['song_type'],
            'slots': slots,
            'translated': translated,
            'preview_ja': preview_ja,
            'preview_zh': preview_zh,
            'mst_song_id': info['mst_song_id']
        })

    # Sort songs by name_ja
    songs_list.sort(key=lambda x: x['name_ja'])

    result = {
        'total_songs': len(songs_list),
        'total_slots': total_slots,
        'total_translated': total_translated,
        'songs': songs_list
    }

    with open(os.path.join(PORTAL_DIR, 'src', 'songs_catalog.js'), 'w', encoding='utf-8') as out:
        out.write('export const SONGS_CATALOG = ' + json.dumps(result, ensure_ascii=False) + ';\n')

    with open(os.path.join(PORTAL_DIR, 'src', 'songs_catalog.json'), 'w', encoding='utf-8') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)

    if args.write_static_lyrics:
        asset_songs, asset_lines = build_lyric_assets(asset_version=args.asset_version)
        print(f'Successfully built static lyric assets: {asset_songs} files, {asset_lines} lines in {LYRIC_ASSET_DIR}.')
        print('NOTE: these files are retired and are not read at runtime; this emission was '
              'requested explicitly with --write-static-lyrics.')
    else:
        existing = 0
        if os.path.isdir(LYRIC_ASSET_DIR):
            existing = len([name for name in os.listdir(LYRIC_ASSET_DIR) if name.endswith('.json')])
        print(f'Skipped static lyric assets: {LYRIC_ASSET_DIR} is retired (the Worker no longer '
              f'reads /data/lyrics/<bundle>.json and app.js refuses a static fallback). '
              f'{existing} existing files left untouched. Pass --write-static-lyrics to regenerate them.')

    print(f'Successfully built songs_catalog.js: {len(songs_list)} songs, {total_slots} slots.')


if __name__ == '__main__':
    main()
