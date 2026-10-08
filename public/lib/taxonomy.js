// 分类与偶像归属规则：生成器（node）和浏览器读同一份代码，规则不会分叉。
//
// 原来的规则分散在 Worker 的 `src/categories.js` 与 `src/worker.js` 里；门户改成
// 静态站后，生成数据的脚本和读数据的页面必须使用同一套判定，所以它们合并到这里，
// 由 `scripts/build_data.mjs` 与 `public/app.js` 同时 import。

import { IDOLS, SPEAKERS, IDOL_MAP } from "./terms.js";

/// 一个分类的稳定标识与展示文案。
export const CATEGORY_RULES = {
  lyrics: { id: "lyrics", domain: "lyrics", name: "全曲打歌歌词", description: "按正式 Assets 曲目束逐行对照与翻译", domain_name: "歌曲歌词", icon: "🎵", unit: "句", entry: "lyrics" },
  event_chat: { id: "event_chat", domain: "story", name: "活动短信与聊天", description: "制作人与偶像活动手机联络", domain_name: "剧场剧情", icon: "📱", unit: "句", entry: "studio" },
  event_story: { id: "event_story", domain: "story", name: "活动剧情篇章", description: "巡回与剧场活动全篇章节故事", domain_name: "剧场剧情", icon: "🌟", unit: "句", entry: "studio" },
  special_commu: { id: "special_commu", domain: "story", name: "特别企划与回想", description: "特别活动、周年企划与回忆录", domain_name: "剧场剧情", icon: "🎭", unit: "句", entry: "studio" },
  main_commu: { id: "main_commu", domain: "story", name: "主线剧情故事", description: "偶像个人主线剧情与剧场篇章", domain_name: "剧场剧情", icon: "📖", unit: "句", entry: "studio" },
  card_episode: { id: "card_episode", domain: "card", name: "卡片专属觉醒物语", description: "SSR/SR 卡片觉醒物语与专属剧情", domain_name: "卡片物语", icon: "🎴", unit: "句", entry: "studio" },
  card_blog: { id: "card_blog", domain: "card", name: "偶像博客与私信", description: "卡片获得后的剧场博客与短信", domain_name: "卡片物语", icon: "💌", unit: "句", entry: "studio" },
  card_skill: { id: "card_skill", domain: "card", name: "卡片技能与卡面档案", description: "队长技、演出技能与专属介绍", domain_name: "卡片物语", icon: "⚔️", unit: "句", entry: "studio" },
  theater_comm: { id: "theater_comm", domain: "dialogue", name: "剧场工作互动对话", description: "事务所各房间触碰与日常工作台词", domain_name: "剧场日常", icon: "🏢", unit: "句", entry: "studio" },
  message_board: { id: "message_board", domain: "dialogue", name: "剧场白板日常留言", description: "休息室白板留言涂鸦与问候", domain_name: "剧场日常", icon: "📝", unit: "句", entry: "studio" },
  live_result: { id: "live_result", domain: "dialogue", name: "演出打歌结算赞誉", description: "LIVE 完成打气与结算台词", domain_name: "剧场日常", icon: "🎤", unit: "句", entry: "studio" },
  login_bonus: { id: "login_bonus", domain: "dialogue", name: "登录特别演出台词", description: "签到剧场演出与纪念问候", domain_name: "剧场日常", icon: "🎁", unit: "句", entry: "studio" },
  birth_live: { id: "birth_live", domain: "birth", name: "生日特别演出剧情", description: "偶像生日专属 LIVE 演出剧情", domain_name: "纪念庆典", icon: "🎂", unit: "句", entry: "studio" },
  birth_greet: { id: "birth_greet", domain: "birth", name: "生日剧场玄关祝贺", description: "生日当天玄关祝贺与白板留言", domain_name: "纪念庆典", icon: "🎈", unit: "句", entry: "studio" },
  system_ui: { id: "system_ui", domain: "system", name: "系统菜单与玩法规则", description: "界面底栏、UI 引导、道具与提示弹窗", domain_name: "界面系统", icon: "⚙️", unit: "句", entry: "studio" },
};

/// 分类的稳定展示顺序。索引和统计都按它排序，页面不必再排一次。
export const CATEGORY_ORDER = Object.keys(CATEGORY_RULES);

export const DOMAIN_META = {
  lyrics: { name: "歌曲歌词", icon: "🎵" },
  story: { name: "剧场剧情", icon: "📖" },
  card: { name: "卡片物语", icon: "🎴" },
  dialogue: { name: "剧场日常", icon: "🏢" },
  birth: { name: "纪念庆典", icon: "🎂" },
  system: { name: "界面系统", icon: "⚙️" },
};

export const DOMAIN_ORDER = Object.keys(DOMAIN_META);

/// 上游翻译仓库里，每个分类的 JSONL 落在 `locales/` 的哪个子目录。
/// 歌词是唯一例外：它在 `lyrics/songs/`。
export const EXPORT_DIRECTORY_BY_CATEGORY = {
  lyrics: "lyrics",
  event_chat: "story",
  event_story: "story",
  special_commu: "story",
  main_commu: "story",
  card_episode: "card",
  card_blog: "card",
  card_skill: "card",
  theater_comm: "dialogue",
  message_board: "dialogue",
  live_result: "dialogue",
  login_bonus: "dialogue",
  birth_live: "birth",
  birth_greet: "birth",
  system_ui: "master",
};

/// 图片任务的三个分类（与图片清单里的 `category` 对应）。
export const IMAGE_CATEGORY_RULES = {
  event: { id: "event", name: "活动宣传与公告横幅", icon: "🎪" },
  costume: { id: "costume", name: "专属服饰与扭蛋海报", icon: "👗" },
  tutorial: { id: "tutorial", name: "玩法引导与教学图解", icon: "📖" },
};
export const IMAGE_CATEGORY_ORDER = Object.keys(IMAGE_CATEGORY_RULES);

/// 图片任务按**上游 bundle 名前缀**分类。上游 manifest 里没有分类字段，只有 bundle
/// （`event_0015_info.unity3d` / `tutorialinfo08.unity3d` / `costumesalesinfo0014.unity3d`），
/// 所以判定只能落在名字上，且必须以真实数据为准。
export function detectImageCategory(bundle) {
  const b = String(bundle || "").toLowerCase();
  if (b.startsWith("tutorial")) return "tutorial";
  if (b.startsWith("costume") || b.includes("salesinfo")) return "costume";
  if (b.startsWith("event")) return "event";
  return null;
}

/// 一个 bundle（可选带 item_key）属于哪个分类。
export function categoryId(bundle, itemKey = "") {
  const b = String(bundle || "").toLowerCase();
  const k = String(itemKey || "").toLowerCase();

  if (b.startsWith("scrobj_") || b.includes("lyric")) return "lyrics";
  if (b.startsWith("event_") && (b.includes("chat") || k.includes("chat"))) return "event_chat";
  if (b.startsWith("event_") || (b.includes("story") && !b.startsWith("special_"))) return "event_story";
  if (b.startsWith("special_")) return "special_commu";
  if (b === "st_jp.gtx" || b.startsWith("st_")) return "main_commu";
  if (b.startsWith("card_episode_")) return "card_episode";
  if (b.startsWith("card_blst_")) return "card_blog";
  if (b === "cd_jp.gtx" || b.startsWith("cd_")) return "card_skill";
  if (b === "cm_jp.gtx" || b.startsWith("cm_")) return "theater_comm";
  if (b === "mb_jp.gtx" || b.startsWith("mb_")) return "message_board";
  if (b.startsWith("liveresult_")) return "live_result";
  if (b.startsWith("lbonus_")) return "login_bonus";
  if (b.startsWith("birth_bdl")) return "birth_live";
  if (b.startsWith("birth_ent") || b.startsWith("birth_")) return "birth_greet";
  return "system_ui";
}

export function detectCategory(bundle, itemKey = "") {
  return CATEGORY_RULES[categoryId(bundle, itemKey)] || CATEGORY_RULES.system_ui;
}

/// 该 bundle 在上游仓库里是否有可写位置（`locales/<dir>/<base>.jsonl` 或
/// `lyrics/songs/<base>.jsonl`）。返回 `null` 表示没有：页面显示只读，不显示编辑。
export function upstreamPathForBundle(bundle, itemKey = "") {
  const name = String(bundle || "").trim();
  if (!name) return null;
  const base = name.replace(/\.unity3d$/i, "");
  if (!base || /[\\/]/.test(base)) return null;
  const category = categoryId(name, itemKey);
  if (category === "lyrics") return `lyrics/songs/${base}.jsonl`;
  const directory = EXPORT_DIRECTORY_BY_CATEGORY[category];
  if (!directory) return null;
  return `locales/${directory}/${base}.jsonl`;
}

/// 行落在哪一位偶像身上：先看 item_key 里的 `001har` 形状，再看 bundle，最后看
/// 说话人表。判定不出来返回 `null`（不是"默认第一位偶像"）。
export function detectIdol(bundle, itemKey, source) {
  if (itemKey) {
    const m = String(itemKey).match(/(?:^|_|(?<=[a-z]))(\d{3}[a-z]{3})(?:_|$|[a-z0-9])/i);
    if (m && IDOL_MAP.has(m[1].toLowerCase())) return IDOL_MAP.get(m[1].toLowerCase());
    for (const [code, sp] of Object.entries(SPEAKERS)) {
      if (String(itemKey).includes(code)) {
        const idol = IDOL_MAP.get(code);
        if (idol) return idol;
        return { code, id: 0, name_ja: sp.name_ja, name_zh: sp.name_zh, type: "Guest", color: "#666666" };
      }
    }
  }
  if (bundle) {
    const m = String(bundle).match(/(\d{3}[a-z]{3})/i);
    if (m && IDOL_MAP.has(m[1].toLowerCase())) return IDOL_MAP.get(m[1].toLowerCase());
  }
  return null;
}

export { IDOLS, SPEAKERS, IDOL_MAP };

/// 计数：一次遍历得出浏览用的几个数，避免各调用点各算一遍。
/// `not_needed` = 原文非日文且没有译文（英文歌词这类），既不算已翻译也不算未翻译。
export function statusCounts(rows) {
  const counts = { total: 0, translated: 0, pending: 0, untranslated: 0, not_needed: 0 };
  for (const row of rows) {
    counts.total += 1;
    const status = String(row?.status || "").toLowerCase();
    if (status === "accepted") counts.translated += 1;
    else if (status === "pending" || status === "needs_review") counts.pending += 1;
    else if (status === "not_needed") counts.not_needed += 1;
    else counts.untranslated += 1;
  }
  return counts;
}
