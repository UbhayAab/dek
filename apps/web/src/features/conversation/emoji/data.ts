// Bundled emoji list (works offline, no CDN): about 300 common emoji with their
// lowercase CLDR names and search keywords, grouped for the picker. Recents live in
// localStorage per user, as a convenience only (every access is guarded).

export interface EmojiItem {
  ch: string;
  name: string;
  keywords: string[];
}

export interface EmojiGroup {
  id: string;
  label: string;
  icon: string;
  items: EmojiItem[];
}

// Each entry is "<emoji> <name>|<keyword>|<keyword>", entries separated by commas.
function group(id: string, label: string, icon: string, blob: string): EmojiGroup {
  const items = blob
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry): EmojiItem => {
      const space = entry.indexOf(' ');
      const [name = '', ...keywords] = entry.slice(space + 1).split('|').map((s) => s.trim().toLowerCase());
      return { ch: entry.slice(0, space), name, keywords: keywords.filter(Boolean) };
    });
  return { id, label, icon, items };
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  group('smileys', 'Smileys', '😀', `
    😀 grinning face|grin|happy|smile, 😃 grinning face with big eyes|smiley|happy,
    😄 grinning face with smiling eyes|smile|happy, 😁 beaming face with smiling eyes|beam|grin,
    😆 grinning squinting face|laugh|lol, 😅 grinning face with sweat|sweat|phew|relief,
    🤣 rolling on the floor laughing|rofl|lol, 😂 face with tears of joy|joy|lol|laugh,
    🙂 slightly smiling face|smile, 🙃 upside-down face|upside down|silly, 😉 winking face|wink,
    😊 smiling face with smiling eyes|blush|happy, 😇 smiling face with halo|halo|angel|innocent,
    🥰 smiling face with hearts|love|adore, 😍 smiling face with heart-eyes|heart eyes|love|crush,
    🤩 star-struck|star struck|wow|excited, 😘 face blowing a kiss|kiss,
    😋 face savoring food|yum|tasty|delicious, 😜 winking face with tongue|tongue|joking,
    🤪 zany face|crazy|goofy, 🤑 money-mouth face|money|rich, 🤗 smiling face with open hands|hug|hugs,
    🤭 face with hand over mouth|oops|giggle, 🤫 shushing face|shh|quiet|secret,
    🤔 thinking face|think|thinking|hmm, 🤐 zipper-mouth face|zipper|secret,
    🤨 face with raised eyebrow|suspicious|skeptical, 😐 neutral face|meh, 😶 face without mouth|speechless|silent,
    😏 smirking face|smirk, 😒 unamused face|unamused, 🙄 face with rolling eyes|eye roll|whatever,
    😬 grimacing face|grimace|awkward|eek, 😌 relieved face|relieved|calm, 😔 pensive face|pensive|sad,
    😴 sleeping face|sleep|zzz|tired, 😷 face with medical mask|mask|sick,
    🤒 face with thermometer|sick|fever|ill, 🤕 face with head-bandage|hurt|injured,
    🤢 nauseated face|sick, 🤧 sneezing face|sneeze|cold, 🥵 hot face|hot|heat, 🥶 cold face|cold|freezing,
    🥴 woozy face|woozy|dizzy, 😵 face with crossed-out eyes|dizzy, 🤯 exploding head|mind blown|shocked,
    🤠 cowboy hat face|cowboy, 🥳 partying face|party|celebrate|birthday,
    😎 smiling face with sunglasses|cool|sunglasses, 🤓 nerd face|nerd|geek, 🧐 face with monocle|curious,
    😕 confused face|confused, 😟 worried face|worried|concerned, 🙁 slightly frowning face|frown|sad,
    😮 face with open mouth|wow|surprised, 😲 astonished face|astonished|shocked,
    😳 flushed face|flushed|embarrassed, 🥺 pleading face|pleading|please, 😨 fearful face|fearful|scared,
    😰 anxious face with sweat|anxious|nervous, 😢 crying face|cry|sad|tear, 😭 loudly crying face|sob|crying,
    😱 face screaming in fear|scream|fear, 😞 disappointed face|disappointed, 😫 tired face|tired|exhausted,
    🥱 yawning face|yawn|bored, 😤 face with steam from nose|huff|frustrated, 😡 enraged face|rage|angry,
    😠 angry face|angry|mad, 💀 skull|dead, 💩 pile of poo|poop, 🤡 clown face|clown, 👻 ghost|boo,
    👽 alien|ufo, 🤖 robot|bot, 🙈 see-no-evil monkey|see no evil|monkey|oops
  `),
  group('gestures', 'Gestures', '👋', `
    👋 waving hand|wave|hi|hello|bye, 🤚 raised back of hand|raised hand, ✋ raised hand|stop|high five,
    🖐️ hand with fingers splayed|hand, 👌 ok hand|ok|perfect, 🤌 pinched fingers|pinch,
    🤏 pinching hand|small|tiny, ✌️ victory hand|victory|peace, 🤞 crossed fingers|fingers crossed|luck|hope,
    🤟 love-you gesture|love you, 🤘 sign of the horns|rock, 🤙 call me hand|call me|shaka,
    👈 backhand index pointing left|left|point, 👉 backhand index pointing right|right|point,
    👆 backhand index pointing up|up|point, 👇 backhand index pointing down|down|point,
    ☝️ index pointing up|point up|one, 👍 thumbs up|like|yes|agree|+1|good|approve,
    👎 thumbs down|dislike|no|disagree|-1|bad, ✊ raised fist|fist|power, 👊 oncoming fist|punch|fist bump,
    🤛 left-facing fist|fist bump, 🤜 right-facing fist|fist bump,
    👏 clapping hands|clap|applause|bravo|well done, 🙌 raising hands|hooray|praise|celebrate,
    👐 open hands|open, 🤲 palms up together|palms, 🤝 handshake|deal|agreement|partnership,
    🙏 folded hands|pray|please|thanks|thank you|namaste, ✍️ writing hand|write|writing,
    💪 flexed biceps|strong|muscle|flex, 🧠 brain|smart|think, 👀 eyes|look|watching|seen, 👂 ear|listen|hear
  `),
  group('people', 'People', '🧑', `
    🧑‍💻 technologist|developer|coder|laptop, 🧑‍⚕️ health worker|doctor|nurse|health,
    👩‍⚕️ woman health worker|doctor|nurse, 👨‍⚕️ man health worker|doctor|nurse, 🧑‍🏫 teacher|school|teach,
    🧑‍🎓 student|graduate|study, 🧑‍💼 office worker|office|business, 🧑‍🔬 scientist|lab|research,
    🙋 person raising hand|raise hand|question|me, 🙇 person bowing|bow|sorry|respect,
    🤦 person facepalming|facepalm|doh, 🤷 person shrugging|shrug|dunno, 🙅 person gesturing no|no|nope,
    🙆 person gesturing ok|ok|yes, 🧘 person in lotus position|yoga|meditate|calm,
    🏃 person running|run|running|hurry, 💃 woman dancing|dance|party, 🕺 man dancing|dance|party,
    👥 busts in silhouette|people|team|group, 🫂 people hugging|hug|support
  `),
  group('nature', 'Nature', '🌿', `
    🐶 dog face|dog|puppy, 🐱 cat face|cat|kitten, 🐰 rabbit face|rabbit|bunny, 🦊 fox, 🐻 bear, 🐼 panda,
    🐯 tiger face|tiger, 🦁 lion, 🐮 cow face|cow, 🐵 monkey face|monkey, 🐔 chicken, 🐧 penguin, 🐦 bird,
    🦋 butterfly, 🐝 honeybee|bee|busy, 🐢 turtle|slow, 🐘 elephant, 🐬 dolphin, 🦜 parrot, 🦚 peacock,
    🌵 cactus, 🌳 deciduous tree|tree, 🌴 palm tree|palm|beach, 🌱 seedling|growth|new,
    🌿 herb|plant|leaf, 🍀 four leaf clover|clover|luck, 🍁 maple leaf|autumn,
    🌸 cherry blossom|blossom|flower|spring, 🌹 rose|flower, 🌻 sunflower|flower, 🌷 tulip|flower,
    💐 bouquet|flowers|congrats, 🌍 globe showing europe-africa|earth|world|globe, 🌙 crescent moon|moon|night,
    ⭐ star, 🌟 glowing star|star|shine, ✨ sparkles|magic|shiny|new, ⚡ high voltage|lightning|zap|fast,
    🔥 fire|lit|hot, 💥 collision|boom|explosion, ❄️ snowflake|snow|cold, 🌊 water wave|wave|ocean|sea,
    💧 droplet|water|drop, ☀️ sun|sunny, ⛅ sun behind cloud|cloudy|weather, 🌧️ cloud with rain|rain|weather,
    🌈 rainbow, ☔ umbrella with rain drops|rain|umbrella|monsoon
  `),
  group('food', 'Food and drink', '🍕', `
    🍎 red apple|apple|fruit, 🍌 banana, 🍊 tangerine|orange|fruit, 🍋 lemon, 🍉 watermelon|summer,
    🍇 grapes, 🍓 strawberry, 🥭 mango|aam, 🍍 pineapple, 🥥 coconut, 🍅 tomato, 🥕 carrot,
    🌽 ear of corn|corn|maize, 🌶️ hot pepper|chili|spicy, 🍞 bread|roti|toast, 🧀 cheese wedge|cheese,
    🥚 egg, 🍳 cooking|fried egg|breakfast, 🍔 hamburger|burger, 🍟 french fries|fries, 🍕 pizza,
    🥪 sandwich, 🥗 green salad|salad|healthy, 🍛 curry rice|curry|rice|dal, 🍜 steaming bowl|noodles|soup,
    🍚 cooked rice|rice, 🍱 bento box|lunch|tiffin, 🥟 dumpling|momo, 🍦 soft ice cream|ice cream,
    🍩 doughnut|donut, 🍪 cookie|biscuit, 🎂 birthday cake|cake|birthday, 🍰 shortcake|cake|dessert,
    🍫 chocolate bar|chocolate, 🍬 candy|sweet|mithai, 🍯 honey pot|honey, ☕ hot beverage|coffee|tea|chai,
    🍵 teacup without handle|tea|green tea, 🥤 cup with straw|drink|soda|juice, 🥛 glass of milk|milk,
    🍻 clinking beer mugs|cheers, 🥂 clinking glasses|cheers|celebrate|toast,
    🍾 bottle with popping cork|champagne|celebrate
  `),
  group('activity', 'Activity', '⚽', `
    ⚽ soccer ball|football|soccer, 🏀 basketball, 🏏 cricket game|cricket, 🏸 badminton, 🎾 tennis,
    🏓 ping pong|table tennis, 🏆 trophy|win|winner|champion, 🥇 1st place medal|gold|first|winner,
    🥈 2nd place medal|silver|second, 🥉 3rd place medal|bronze|third, 🏅 sports medal|medal|award,
    🎯 bullseye|target|goal|direct hit, 🎮 video game|game|gaming|controller, 🎲 game die|dice|game,
    🧩 puzzle piece|puzzle|jigsaw, 🎨 artist palette|art|paint|design, 🎭 performing arts|theater|drama,
    🎤 microphone|mic|sing|karaoke, 🎧 headphone|headphones|music, 🎵 musical note|music|note,
    🎶 musical notes|music|notes, 🎸 guitar, 🥁 drum, 🎬 clapper board|film|movie|action,
    🎉 party popper|tada|party|celebrate|congrats|congratulations, 🎊 confetti ball|confetti|celebrate,
    🎈 balloon|birthday, 🎁 wrapped gift|gift|present|birthday, 🪔 diya lamp|diya|diwali|lamp,
    🎆 fireworks|celebrate, 🎇 sparkler|diwali
  `),
  group('travel', 'Travel and places', '🚗', `
    🚗 automobile|car, 🚕 taxi|cab, 🚌 bus, 🚑 ambulance|emergency|hospital, 🚓 police car|police,
    🛺 auto rickshaw|auto|rickshaw|tuk tuk, 🚲 bicycle|bike|cycle, 🛵 motor scooter|scooter,
    🏍️ motorcycle|motorbike, 🚆 train, 🚇 metro|subway, ✈️ airplane|plane|flight|travel,
    🚀 rocket|launch|ship it, ⛵ sailboat|boat|sail, 🏠 house|home, 🏢 office building|office|work,
    🏥 hospital|clinic, 🏫 school, 🏦 bank, 🏛️ classical building|government|museum,
    🛕 hindu temple|temple|mandir, 🕌 mosque, ⛪ church, 🗺️ world map|map|travel,
    🏖️ beach with umbrella|beach|vacation|holiday, ⛰️ mountain|hills, 🏕️ camping|camp,
    🌆 cityscape at dusk|city|evening
  `),
  group('objects', 'Objects', '💡', `
    ⌚ watch|time, 📱 mobile phone|phone|mobile|cell, 💻 laptop|computer, 🖥️ desktop computer|computer|desktop,
    ⌨️ keyboard|typing, 🖨️ printer|print, 📷 camera|photo, 🎥 movie camera|video|film,
    📞 telephone receiver|phone|call, 📺 television|tv, 🔋 battery|charge, 🔌 electric plug|plug|power,
    💡 light bulb|idea|bulb|light, 🔦 flashlight|torch, 💰 money bag|money|funds|grant,
    💸 money with wings|money|spend, 💳 credit card|card|payment, 🧾 receipt|invoice|bill,
    📈 chart increasing|growth|chart|up|trend, 📉 chart decreasing|decline|chart|down,
    📊 bar chart|chart|stats|data, 📅 calendar|date|schedule, 🗓️ spiral calendar|calendar|plan,
    📌 pushpin|pin|pinned|important, 📎 paperclip|attachment|clip, ✂️ scissors|cut,
    📝 memo|note|notes|write, 📄 page facing up|document|page|file, 📁 file folder|folder|files,
    📦 package|box|delivery, 📧 e-mail|email|mail, ✉️ envelope|letter|mail,
    📢 loudspeaker|announcement, 📣 megaphone|announce, 🔔 bell|notification, 🔕 bell with slash|mute|silent,
    🔒 locked|lock|private|secure, 🔓 unlocked|unlock|open, 🔑 key|password, 🔧 wrench|fix|tool,
    🔨 hammer|build, ⚙️ gear|settings, 🧰 toolbox|tools, 💊 pill|medicine|tablet,
    💉 syringe|vaccine|injection, 🩺 stethoscope|doctor|health|checkup, 🩹 adhesive bandage|bandage|plaster,
    🧪 test tube|test|lab|experiment, 🔬 microscope|science, 📚 books|study|library, 📖 open book|book|read,
    ✏️ pencil|edit, 🖊️ pen|sign, ⏰ alarm clock|alarm|clock|time, ⏳ hourglass not done|hourglass|waiting,
    🎓 graduation cap|graduation|degree|education
  `),
  group('symbols', 'Symbols', '❤️', `
    ❤️ red heart|heart|love, 🧡 orange heart|heart, 💛 yellow heart|heart, 💚 green heart|heart,
    💙 blue heart|heart, 💜 purple heart|heart, 🖤 black heart|heart, 🤍 white heart|heart,
    💔 broken heart|heartbreak|sad, 💕 two hearts|love|hearts, 💖 sparkling heart|love|heart,
    💯 hundred points|100|perfect|hundred, ✅ check mark button|done|yes|check|complete,
    ☑️ check box with check|check|done, ✔️ check mark|check|ok, ❌ cross mark|no|wrong|x|cancel,
    ❎ cross mark button|x|no, ⭕ hollow red circle|circle, ❗ red exclamation mark|important|exclamation|alert,
    ❓ red question mark|question|help, ⚠️ warning|caution, 🚫 prohibited|forbidden|no|blocked,
    ⛔ no entry|stop, 🛑 stop sign|stop, 🆘 sos button|sos|help|emergency, 🆕 new button|new,
    🆗 ok button|ok, 🔴 red circle|red|busy, 🟢 green circle|green|online|go, 🟡 yellow circle|yellow|away,
    🔵 blue circle|blue, ➡️ right arrow|right|arrow|next, ⬅️ left arrow|left|arrow|back,
    ⬆️ up arrow|up|arrow, ⬇️ down arrow|down|arrow, 🔄 counterclockwise arrows button|refresh|sync|repeat,
    ♻️ recycling symbol|recycle, 💤 zzz|sleep, 💬 speech balloon|comment|chat|message,
    💭 thought balloon|thought|thinking, 🏁 chequered flag|finish|done|race, 🚩 triangular flag|flag|red flag,
    🇮🇳 flag india|india|flag|tiranga
  `),
];

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '🙏', '👀'];

// Lookups ignore the VS16 presentation selector, so '❤' and '❤️' are one emoji.
const bare = (ch: string) => ch.replace(/️/g, '');

const ALL: EmojiItem[] = EMOJI_GROUPS.flatMap((g) => g.items);
const BY_CH = new Map<string, EmojiItem>(ALL.map((item) => [bare(item.ch), item]));
const WORDS = new Map<EmojiItem, string[]>(ALL.map((item) => [item, [...item.name.split(/[\s-]+/), ...item.keywords]]));

export function emojiName(ch: string): string | null {
  if (!ch) return null;
  return BY_CH.get(bare(ch))?.name ?? null;
}

// Name and keyword prefix matches first (in list order), then substring matches.
export function searchEmoji(q: string, limit = 80): EmojiItem[] {
  const needle = (q ?? '').trim().toLowerCase();
  if (!needle || limit <= 0) return [];
  const prefix: EmojiItem[] = [];
  const contains: EmojiItem[] = [];
  for (const item of ALL) {
    const words = WORDS.get(item) ?? [];
    if (bare(item.ch) === bare(needle) || item.name.startsWith(needle) || words.some((w) => w.startsWith(needle))) {
      prefix.push(item);
    } else if (item.name.includes(needle) || item.keywords.some((k) => k.includes(needle))) {
      contains.push(item);
    }
  }
  return [...prefix, ...contains].slice(0, limit);
}

const RECENT_PREFIX = 'dek.emoji.recent.';
const MAX_RECENT = 24;

function recentKey(userId: string | null): string {
  return `${RECENT_PREFIX}${userId || 'anon'}`;
}

export function recentEmoji(userId: string | null): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(recentKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of parsed) {
      if (typeof x !== 'string' || !x || x.length > 32 || seen.has(x)) continue;
      seen.add(x);
      out.push(x);
      if (out.length >= MAX_RECENT) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function noteEmoji(userId: string | null, ch: string): void {
  if (!ch || ch.length > 32) return;
  try {
    const next = [ch, ...recentEmoji(userId).filter((x) => x !== ch)].slice(0, MAX_RECENT);
    globalThis.localStorage?.setItem(recentKey(userId), JSON.stringify(next));
  } catch {
    // Storage blocked or full: recents are a convenience, the pick still happens.
  }
}
