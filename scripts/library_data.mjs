import { IDOLS, SPEAKERS } from "../public/lib/terms.js";
import { groupSongs } from "../public/lib/songs.js";
import { readableLabel } from "../public/lib/library.js";
import { buildBloom } from "../public/lib/search-core.js";

const people = new Map(IDOLS.map((x) => [x.code, x]));
for (const [code, value] of Object.entries(SPEAKERS)) if (/^20\d/.test(code)) {
  people.set(code, { ...value, code, id: Number(code.slice(0, 3)), type: "Guest", color: "#7c3aed" });
}
const stem = (entry) => entry.bundle.replace(/\.unity3d$/i, "").replace(/_jp\.gtx$/i, "");
const write = (sink, file, doc) => sink.putDocument ? sink.putDocument(file, doc) : sink.put(file, JSON.stringify(doc) + "\n");

function topicFor(record) {
  const name = stem(record);
  let match = /^event_(\d+)_story_(intro|\d+|chat)$/.exec(name);
  if (match) return { id: `event-${match[1]}`, kind: "event", label: `活动 ${Number(match[1])}`,
    order: match[2] === "intro" ? 0 : match[2] === "chat" ? null : Number(match[2]),
    chapter_label: match[2] === "intro" ? "序章" : match[2] === "chat" ? "活动短信与聊天" : `第 ${Number(match[2])} 章` };
  match = /^main_(intro|befo|after|blst|chat)_(\d+)$/.exec(name);
  if (match) {
    const phases = { intro: [0, "开场"], befo: [1, "演出前"], after: [2, "演出后"], blst: [null, "博客"], chat: [null, "短信"] };
    return { id: `main-${match[2]}`, kind: "main", label: `主线第 ${Number(match[2])} 话`,
      order: phases[match[1]][0], chapter_label: phases[match[1]][1] };
  }
  match = /^special_(\d+)_(.+)_(\d+)$/.exec(name);
  if (match) {
    const label = record.title?.name_zh || record.title?.name_ja;
    return { id: `special-${match[1]}-${match[2]}`,
      kind: /周年|anniversary/i.test(`${label || ""} ${record.summary || ""}`) ? "anniversary" : "special",
      label: label || `特别企划 ${Number(match[1])}`, order: Number(match[3]), chapter_label: `第 ${Number(match[3])} 章` };
  }
  match = /^birth_([a-z0-9]+)_(\d{3}[a-z]{3})_(\d+)$/.exec(name);
  if (match && people.has(match[2])) return { id: `birthday-${match[2]}`, kind: "birthday",
    label: `${people.get(match[2]).name_zh || people.get(match[2]).name_ja} · 生日纪念`, order: null,
    chapter_label: `纪念篇 ${Number(match[3])}`, edition: Number(match[3]) };
  return null;
}

export function decorateLibraryBundles(bundles) {
  const texts = new Map(), participants = new Map(), anniversaries = new Map();
  for (const { record, rows } of bundles) {
    const key = `${record.channel}:${record.category}:${record.bundle}`;
    const eventIntro = /^event_(\d+)_story_intro$/.exec(stem(record));
    if (eventIntro) {
      const opening = rows.map((row) => `${row.translation || ""} ${row.source}`).join("\n");
      const theater = /記念公演|纪念公演|劇場(?:の)?記念日|剧场.{0,10}纪念日/.test(opening);
      if (theater || /周年|anniversary/i.test(opening)) {
        const entity = /[『《]([^』》]+)[』》][^。\n]{0,18}?(\d+)\s*周年/.exec(opening);
        const edition = /(\d+)\s*周年/.exec(opening)?.[1];
        const label = theater ? `剧场周年纪念 · 活动 ${Number(eventIntro[1])}`
          : entity ? `${entity[1]} · ${entity[2]} 周年纪念` : `${edition ? edition + " " : ""}周年纪念 · 活动 ${Number(eventIntro[1])}`;
        anniversaries.set(`event-${eventIntro[1]}`, label);
      }
    }
    if (!participants.has(key)) participants.set(key, new Set());
    for (const row of rows) {
      if (people.has(row.idol?.code)) participants.get(key).add(row.idol.code);
      if (/_title$|_synopsis$/.test(row.item_key)) {
        const previous = texts.get(row.item_key);
        if (!previous || Number(row.version || 0) >= Number(previous.version || 0)) texts.set(row.item_key, row);
      }
    }
  }
  for (const { record } of bundles) {
    const name = stem(record), title = texts.get(`${name}_title`), synopsis = texts.get(`${name}_synopsis`);
    const usefulTitle = (value) => value && !/^(?:无|無|なし|none|n\/a|[-ー—])$/i.test(value.trim());
    if (title && (usefulTitle(title.translation) || usefulTitle(title.source))) record.title = {
      name_ja: usefulTitle(title.source) ? title.source : "", name_zh: usefulTitle(title.translation) ? title.translation : "" };
    const referenceNames = { "ST_jp.gtx": "剧情标题与简介", "MD_jp.gtx": "界面与游戏资料", "CD_jp.gtx": "卡片资料", "CM_jp.gtx": "剧场日常对话", "MB_jp.gtx": "剧场白板留言" };
    if (!record.title && referenceNames[record.bundle]) record.title = { name_ja: "", name_zh: referenceNames[record.bundle] };
    if (synopsis) record.summary = (synopsis.translation || synopsis.source).slice(0, 300);
    record.participants = [...participants.get(`${record.channel}:${record.category}:${record.bundle}`)].sort();
    record.topic = topicFor(record);
    if (record.topic && anniversaries.has(record.topic.id)) {
      record.topic.kind = "anniversary"; record.topic.label = anniversaries.get(record.topic.id);
    }
    record.reading_category = record.topic?.kind === "main" ? "main_commu" : record.category;
    if (record.topic) record.topic.file = `library/topics/${record.topic.id}.json`;
    if (!record.title && record.topic) record.title = { name_ja: "", name_zh: `${record.topic.label} · ${record.topic.chapter_label}` };
  }
}

function compact(entry) {
  const result = {};
  for (const key of ["bundle", "file", "category", "reading_category", "channel", "title", "summary", "song", "topic", "participants",
    "total", "translated", "pending", "untranslated", "not_needed"]) if (entry[key] !== undefined) result[key] = entry[key];
  result.label = readableLabel(entry);
  return result;
}

export function emitLibrary(sink, entries) {
  const topics = new Map();
  for (const entry of entries) {
    if (!entry.topic) continue;
    if (!topics.has(entry.topic.id)) topics.set(entry.topic.id, { ...entry.topic, chapters: [] });
    topics.get(entry.topic.id).chapters.push(compact(entry));
  }
  const topicIndex = [];
  for (const topic of topics.values()) {
    topic.chapters.sort((a, b) => (a.topic.order ?? Infinity) - (b.topic.order ?? Infinity)
      || (a.topic.edition ?? 0) - (b.topic.edition ?? 0) || a.bundle.localeCompare(b.bundle, "en", { numeric: true }));
    const numbered = topic.chapters.filter((x) => x.topic.order !== null);
    topic.continuous = numbered.length > 1 && new Set(numbered.map((x) => x.topic.order)).size === numbered.length;
    topic.related = topic.chapters.filter((x) => x.topic.order === null);
    topic.chapters = numbered.length ? numbered : topic.related;
    if (!numbered.length) topic.related = [];
    write(sink, topic.file, topic);
    topicIndex.push({ id: topic.id, file: topic.file, kind: topic.kind, label: topic.label,
      count: topic.chapters.length + topic.related.length, continuous: topic.continuous,
      excerpt: topic.chapters.find((x) => x.summary)?.summary || "" });
  }
  const songs = groupSongs(entries.filter((x) => x.category === "lyrics"));
  const idolIndex = [];
  for (const idol of [...people.values()].sort((a, b) => a.id - b.id)) {
    const relatedSongs = songs.filter((x) => x.song?.default_singers?.some((member) => member.code === idol.code))
      .map((x) => ({ ...compact(x), versions: x.versions.map(compact) }));
    const related = entries.filter((x) => x.category !== "lyrics" && x.participants?.includes(idol.code));
    const birthday = related.filter((x) => x.domain === "birth").map(compact);
    const isStory = (entry) => entry.topic && ["main", "event", "anniversary", "special"].includes(entry.topic.kind);
    const stories = related.filter(isStory).sort((a, b) => Number(b.topic.kind === "main") - Number(a.topic.kind === "main")
      || a.topic.id.localeCompare(b.topic.id, "en", { numeric: true }) || (a.topic.order ?? Infinity) - (b.topic.order ?? Infinity)).map(compact);
    const other = related.filter((x) => !isStory(x) && x.domain !== "birth").map(compact);
    const file = `library/idols/${idol.code}.json`;
    write(sink, file, { idol, songs: relatedSongs, stories, birthday, other });
    idolIndex.push({ ...idol, file, counts: { songs: relatedSongs.length, stories: stories.length, birthday: birthday.length, other: other.length } });
  }
  topicIndex.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  write(sink, "library/index.json", { schema_version: 1, idols: idolIndex, topics: topicIndex });
}

export function emitSearch(sink, bundles, entries, { chunkSize = 5000 } = {}) {
  const byBundle = new Map(entries.map((entry) => [`${entry.channel}:${entry.category}:${entry.bundle}`, entry]));
  const shards = [];
  let rows = [], definitions = [], definitionsMap = new Map(), category, part = 0;
  function flush() {
    if (!rows.length) return;
    const file = `search/part-${String(++part).padStart(4, "0")}.json`;
    const bloom = Buffer.from(buildBloom(rows.flatMap((row) => [row[3], row[4]]))).toString("base64");
    write(sink, file, { files: definitions, rows });
    shards.push({ file, category, count: rows.length, bloom });
    rows = []; definitions = []; definitionsMap = new Map();
  }
  const ordered = bundles.slice().sort((a, b) => a.record.reading_category.localeCompare(b.record.reading_category)
    || a.record.file.localeCompare(b.record.file, "en", { numeric: true }));
  for (const { record, rows: pageRows } of ordered) {
    if (category !== record.reading_category) { flush(); category = record.reading_category; }
    const entry = byBundle.get(`${record.channel}:${record.category}:${record.bundle}`);
    for (let index = 0; index < pageRows.length; index++) {
      if (rows.length >= chunkSize) flush();
      if (!definitionsMap.has(record.file)) {
        definitionsMap.set(record.file, definitions.length);
        definitions.push([entry.file, category, readableLabel(entry), record.page || 1,
          entry.song ? entry.song.default_singers.map((x) => x.code) : entry.participants || []]);
      }
      const row = pageRows[index];
      rows.push([definitionsMap.get(record.file), record.first_index + index, row.item_key,
        row.source, row.translation || "", row.status, row.idol?.code || ""]);
    }
  }
  flush();
  write(sink, "search/index.json", { schema_version: 1, total: shards.reduce((n, x) => n + x.count, 0), shards });
}
