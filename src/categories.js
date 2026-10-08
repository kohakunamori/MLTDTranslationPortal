/// The category taxonomy: a stable code constant, not release data.
///
/// It lives in its own module because two callers need the same mapping: the
/// Worker's read path (to label a row) and the sync runner's summary roll-up (to
/// key `category_summary_json`). A second copy of these rules is how the portal
/// and its summary would start disagreeing about what "活动剧情篇章" contains.

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

/// Map a bundle (and optionally an item key) onto its category id. Both the
/// Worker's read path and the summary roll-up call this, so a row's label and
/// the bucket it is counted in can never drift apart.
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

/// The full category record for a bundle, as the portal renders it.
export function detectCategory(bundle, itemKey = "") {
  return CATEGORY_RULES[categoryId(bundle, itemKey)] || CATEGORY_RULES.system_ui;
}
