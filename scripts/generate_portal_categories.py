import argparse
import glob
import json
import os
import sys

# The portal reads the asset-server localization repository (locales/**).
DEFAULT_REPO_ROOT = 'build/runs/text-localization/9.0.200/github-export-candidate'
REPO_ROOT = DEFAULT_REPO_ROOT
DEFAULT_ASSET_VERSION = os.environ.get('PORTAL_DEFAULT_ASSET_VERSION', '1077100')


def main():
    global REPO_ROOT

    parser = argparse.ArgumentParser(description=__doc__ or 'Regenerate the portal category catalogue')
    parser.add_argument(
        '--repo-root',
        default=DEFAULT_REPO_ROOT,
        help='Localization repository checkout to read locales/ from',
    )
    parser.add_argument(
        '--asset-version',
        default=DEFAULT_ASSET_VERSION,
        help=f'Target asset version for portal catalogue (default: {DEFAULT_ASSET_VERSION})',
    )
    args = parser.parse_args()
    REPO_ROOT = args.repo_root
    target_asset_version = args.asset_version

    with open('web/translation-portal/src/terms.js', 'r', encoding='utf-8') as f:
        text = f.read()

    idols_json = text[text.find('export const IDOLS = ') + len('export const IDOLS = '):text.find('export const SPEAKERS = ')].strip()
    if idols_json.endswith(';'):
        idols_json = idols_json[:-1]
    idols = json.loads(idols_json)
    idol_map = {i['code'].lower(): i for i in idols}

    DOMAINS = {
        'story': {'id': 'story', 'name': '剧场剧情', 'icon': '📖', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0},
        'card': {'id': 'card', 'name': '卡片物语', 'icon': '🎴', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0},
        'dialogue': {'id': 'dialogue', 'name': '剧场日常', 'icon': '🏢', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0},
        'birth': {'id': 'birth', 'name': '纪念庆典', 'icon': '🎂', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0},
        'system': {'id': 'system', 'name': '界面系统', 'icon': '⚙️', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0}
    }

    SUBCATS = {
        'event_story': {'id': 'event_story', 'domain': 'story', 'name': '活动剧情篇章', 'desc': '巡回与剧场活动全篇章节故事', 'icon': '🌟', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'main_commu': {'id': 'main_commu', 'domain': 'story', 'name': '主线剧情故事', 'desc': '偶像个人主线剧情与剧场篇章', 'icon': '📖', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'special_commu': {'id': 'special_commu', 'domain': 'story', 'name': '特别企划与回想', 'desc': '特别活动、周年企划与回忆录', 'icon': '🎭', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'event_chat': {'id': 'event_chat', 'domain': 'story', 'name': '活动短信与聊天', 'desc': '制作人与偶像活动手机联络', 'icon': '📱', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},

        'card_episode': {'id': 'card_episode', 'domain': 'card', 'name': '卡片专属觉醒物语', 'desc': 'SSR/SR 卡片觉醒物语与专属剧情', 'icon': '🎴', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'card_blog': {'id': 'card_blog', 'domain': 'card', 'name': '偶像博客与私信', 'desc': '卡片获得后的剧场博客与短信', 'icon': '💌', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'card_skill': {'id': 'card_skill', 'domain': 'card', 'name': '卡片技能与卡面档案', 'desc': '队长技、演出技能与专属介绍', 'icon': '⚔️', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},

        'theater_comm': {'id': 'theater_comm', 'domain': 'dialogue', 'name': '剧场工作互动对话', 'desc': '事务所各房间触碰与日常工作台词', 'icon': '🏢', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'message_board': {'id': 'message_board', 'domain': 'dialogue', 'name': '剧场白板日常留言', 'desc': '休息室白板留言涂鸦与问候', 'icon': '📝', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'live_result': {'id': 'live_result', 'domain': 'dialogue', 'name': '演出打歌结算赞誉', 'desc': 'LIVE 完成打气与结算台词', 'icon': '🎤', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'login_bonus': {'id': 'login_bonus', 'domain': 'dialogue', 'name': '登录特别演出台词', 'desc': '签到剧场演出与纪念问候', 'icon': '🎁', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},

        'birth_live': {'id': 'birth_live', 'domain': 'birth', 'name': '生日特别演出剧情', 'desc': '偶像生日专属 LIVE 演出剧情', 'icon': '🎂', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},
        'birth_greet': {'id': 'birth_greet', 'domain': 'birth', 'name': '生日剧场玄关祝贺', 'desc': '生日当天玄关祝贺与白板留言', 'icon': '🎈', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0},

        'system_ui': {'id': 'system_ui', 'domain': 'system', 'name': '系统菜单与玩法规则', 'desc': '界面底栏、UI引导、道具与提示弹窗', 'icon': '⚙️', 'total': 0, 'accepted': 0, 'pending': 0, 'untranslated': 0, 'bundle_count': 0}
    }

    def classify(bundle, key=''):
        b = bundle.lower()
        k = key.lower()
        if b.startswith('event_') and ('chat' in b or 'chat' in k):
            return 'event_chat'
        if b.startswith('event_'):
            return 'event_story'
        if b.startswith('special_'):
            return 'special_commu'
        if b.startswith('card_episode_'):
            return 'card_episode'
        if b.startswith('card_blst_'):
            return 'card_blog'
        if b == 'st_jp.gtx':
            return 'main_commu'
        if b == 'cd_jp.gtx':
            return 'card_skill'
        if b == 'cm_jp.gtx':
            return 'theater_comm'
        if b == 'mb_jp.gtx':
            return 'message_board'
        if b.startswith('liveresult_'):
            return 'live_result'
        if b.startswith('lbonus_'):
            return 'login_bonus'
        if b.startswith('birth_bdl'):
            return 'birth_live'
        if b.startswith('birth_ent'):
            return 'birth_greet'
        if b == 'md_jp.gtx':
            return 'system_ui'
        return 'system_ui'

    bundles_by_cat = {cid: set() for cid in SUBCATS}
    idol_stats = {i['code']: {**i, 'total': 0, 'accepted': 0, 'pending': 0} for i in idols}

    total = 0
    accepted = 0
    pending = 0
    untranslated = 0

    hot_items = []
    base_versions = set()

    for f in glob.glob(os.path.join(REPO_ROOT, 'locales', '**', '*.jsonl'), recursive=True):
        for line in open(f, 'r', encoding='utf-8'):
            row = json.loads(line)
            total += 1
            st = row.get('status', 'untranslated')
            if st == 'accepted':
                accepted += 1
            elif st == 'pending':
                pending += 1
            else:
                untranslated += 1

            bundle = row.get('bundle', '')
            item_key = row.get('item_key', '')
            cid = classify(bundle, item_key)
            dom = SUBCATS[cid]['domain']

            bundles_by_cat[cid].add(bundle)
            SUBCATS[cid]['total'] += 1
            DOMAINS[dom]['total'] += 1

            if st == 'accepted':
                SUBCATS[cid]['accepted'] += 1
                DOMAINS[dom]['accepted'] += 1
            elif st == 'pending':
                SUBCATS[cid]['pending'] += 1
                DOMAINS[dom]['pending'] += 1
            else:
                SUBCATS[cid]['untranslated'] += 1
                DOMAINS[dom]['untranslated'] += 1

            # Check idol
            for code in idol_map:
                if code in bundle.lower() or code in item_key.lower():
                    idol_stats[code]['total'] += 1
                    if st == 'accepted':
                        idol_stats[code]['accepted'] += 1
                    elif st == 'pending':
                        idol_stats[code]['pending'] += 1
                    break

            # Edge hot catalogue: every row that still needs translation is packed
            # into the worker module, so browsing / keyword search never scans D1.
            # The old D1 path scanned the whole 74,569-row catalogue per request and
            # exhausted the daily row-read quota. Accepted rows are deliberately not
            # shipped here: they are already translated and readable in the GitHub
            # SSOT repo, and including them would triple the module size.
            #
            # Compact keys keep the module small; the worker reads them through
            # scripts-independent helpers in web/translation-portal/src/worker.js.
            if st != 'accepted':
                item = {'c': cid, 'b': bundle, 'k': item_key, 's': row.get('ja', '')}
                if st != 'untranslated':
                    item['st'] = st
                if row.get('zh'):
                    item['t'] = row['zh']
                hot_items.append(item)
                base_versions.add(row.get('base_version', target_asset_version))

    # Decouple asset version from legacy base_version string
    hot_asset_version = target_asset_version
    # Retain legacy base_version format for backward-compatibility if present, otherwise use hot_asset_version
    hot_base_version = hot_asset_version
    hot_items.sort(key=lambda item: (item['c'], item['b'], item['k']))

    for cid, sub in SUBCATS.items():
        sub['bundle_count'] = len(bundles_by_cat[cid])
        tot = sub['total']
        sub['progress_percent'] = round((sub['accepted'] / tot) * 100, 1) if tot > 0 else 0

    for dom, d in DOMAINS.items():
        tot = d['total']
        d['progress_percent'] = round((d['accepted'] / tot) * 100, 1) if tot > 0 else 0

    progress_percent = round((accepted / total) * 100, 2) if total > 0 else 0
    summary = {
        'total': total,
        'untranslated': untranslated,
        'pending': pending,
        'accepted': accepted,
        'rejected': 0,
        'needs_review': 0,
        'progress_percent': progress_percent,
        'contributors': 1
    }

    payload = {
        **summary,
        'summary': summary,
        'domains': DOMAINS,
        'domain_list': list(DOMAINS.values()),
        'categories': SUBCATS,
        'subcategories': list(SUBCATS.values()),
        'idols': list(idol_stats.values()),
        'by_idol': idol_stats
    }

    with open('web/translation-portal/src/stats_snapshot.json', 'w', encoding='utf-8') as out:
        json.dump(payload, out, ensure_ascii=False, indent=2)

    with open('web/translation-portal/src/stats_snapshot.js', 'w', encoding='utf-8') as out:
        out.write('export const DEFAULT_STATS = ' + json.dumps(payload, ensure_ascii=False) + ';\n')

    with open('web/translation-portal/src/hot_catalogue.js', 'w', encoding='utf-8') as out:
        out.write(
            '// Generated by scripts/generate_portal_categories.py — every row that still needs\n'
            '// translation, packed for edge-side browsing so /api/catalogue/search never scans D1.\n'
            '// Field names are short on purpose (module size); see HOT_ASSET_VERSION below.\n'
            f'export const HOT_ASSET_VERSION = {json.dumps(hot_asset_version)};\n'
            f'export const HOT_BASE_VERSION = {json.dumps(hot_base_version)};\n'
            'export const HOT_CATALOGUE = '
            + json.dumps(hot_items, ensure_ascii=False, separators=(',', ':'))
            + ';\n'
        )

    print(f'Done! Processed {total} rows. Hot catalogue has {len(hot_items)} untranslated/pending items '
          f'(asset_version {hot_asset_version}, legacy base_version {hot_base_version}).')

if __name__ == '__main__':
    main()
