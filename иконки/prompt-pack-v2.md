# Задание Nano Banana: пак v2 — персонаж на цветном диске (16 эмодзи)

Переделка [`prompt-pack.md`](prompt-pack.md) после того, как пак v1 пожил
в канале. Состав, имена и порядок ячеек те же — меняется **композиция**:
цвет уходит из кепки в фон-диск, а три иконки обратной связи перестают быть
мордой и становятся лапой.

Один промпт, один лист 4×4, нарезка тем же `slice_grid.py` и тем же
`names-c.txt`. **Код трогать не нужно**: имена эмодзи не меняются.

---

## Что не так с v1

Три жалобы, и все три — про то, как пак читается **в плашке реакции**, где
эмодзи рисуется примерно в 20–22 px, а не в 128.

| жалоба | что за ней стоит |
|---|---|
| «мелкие» | иконка — персонаж на прозрачном фоне, и в плашке от него остаётся светлое пятно того же тона, что интерфейс. Заполненной площади нет, границы нет |
| «непонятна окраска» | вердикт отдан цвету кепки, а кепка занимает примерно **четверть** высоты иконки и в 22 px превращается в две-три цветные точки над мордой. Зелёная и жёлтая на таком размере не различаются вовсе |
| обратную связь не разобрать | 👍 в v1 — лапа персонажа сбоку от морды, то есть примерно **одна восьмая** кадра. На кнопке «Помогло» человек видит собаку и не видит жеста |

Общий диагноз один: **на 22 px читается только заливка, а у v1 залито
меньше половины кадра, и то в цвет интерфейса.**

## Что меняется

**1. Цвет переезжает из кепки в диск под персонажем.** Вердикт несёт
сплошной цветной круг во весь кадр — то есть примерно 70% площади вместо
четверти. Кепка во всех шестнадцати ячейках остаётся синей джинсовой:
она признак персонажа, а не состояния, и перекрашивать её больше незачем.

**2. Предметы становятся белыми.** Зелёная галка на зелёном диске не видна,
и это относится ко всем шести предметам сразу. Белый читается на любом
из пяти цветов палитры и заодно снимает вопрос «а какого цвета галка».

**3. Голова обрезается диском, как аватарка.** Персонаж больше не стоит
с полями со всех сторон: грудь уходит за нижний край круга. Голова от этого
влезает крупнее при той же площади кадра.

**4. Три ячейки обратной связи — лапа, а не морда.** `bully_helpful`,
`bully_not_helpful`, `bully_detail` живут на кнопках и в подтверждении,
где рядом с ними стоит подпись и места на портрет нет. Там нужен
**привычный жест**: палец вверх, палец вниз, «записываю». Жест делает лапа
нашего бульдожки — узнаваемость держится шерстью, стилем и цветом диска,
а не мордой.

Что при этом **не меняется**: сам персонаж, рендер, свет, глаза, надпись
CROSS, серый фон листа, набор из шестнадцати имён и порядок ячеек.

## Правило пака v2: диск — как прошло, предмет — что случилось

| канал | что кодирует | почему |
|---|---|---|
| **цвет диска** | исход: зелёный — ок, янтарный — с оговорками, красный — не ок, сине-серый — непонятно, тёмно-синий — просто работа | заливка во весь кадр — единственное, что переживает уменьшение до 22 px |
| **субъект** | голова — про обращение и уверенность, лапа — про оценку ответа человеком | две семьи не путаются между собой даже пятном |
| **белый предмет** | событие: галка, крест, лупа, замок, стрелка, флажок, треугольник | работает на 128 px, когда человек навёл курсор или открыл список эмодзи |

**Четыре ячейки третьей строки — без предмета вовсе.** Это светофор
уверенности (`🟢 🟡 🔴 ⚪` в шапке ответа), и там диск — весь сигнал.
Пустой круг отличает их от вердиктов: `bully_done` — зелёный диск И белая
галка, `bully_high` — просто зелёный диск. Правило из v1, и оно осталось
верным: на 22 px эти пары различаются только наличием предмета.

## Палитра: нейтрально-серого диска быть не может

Пять цветов, и это не вкус, а ограничение вырезания фона.

| роль | цвет | насыщенность |
|---|---|---|
| ок | `#2E9E5B` зелёный | 112 |
| с оговорками | `#E09A2B` янтарный | 181 |
| не ок | `#D2453F` красный | 147 |
| просто работа | `#24406E` тёмно-синий | 74 |
| непонятно | `#7A879C` сине-серый | 34 |

Фон снимается по признаку «нейтральный серый» (`sheet.key_background`,
порог `SAT_MAX = 12`), поэтому **светло-серый диск для `bully_unknown` —
тот, который напрашивается по аналогии со светло-серой кепкой v1, — вырежется
вместе с фоном.** Проверено синтетической ячейкой: с жёстким краем диск
выживает (заливку останавливает перепад яркости), но с мягким краем, а он
у рендера мягкий всегда, — нет.

| диск | край жёсткий | край мягкий 1.5 px | край мягкий 3 px |
|---|---|---|---|
| `#2E9E5B` зелёный | цел | цел | цел |
| `#7A879C` сине-серый | цел | цел | цел |
| `#A0A0A0` серый | цел | цел | **съеден** |
| `#8A8A8A` серый | цел | **съеден** | **съеден** |

Отсюда правило на будущее: **любой новый цвет диска — не серый, разница
между максимальным и минимальным каналом не меньше 30.** У `#7A879C`
она 34, и это самый близкий к серому цвет, который можно себе позволить.

Второе ограничение — **тёмно-синий, а не джинсовый**: диск по умолчанию
стоит за синей джинсовой кепкой, и если взять их одного тона, кепка
на диске пропадёт. `#24406E` заметно темнее кепки, CROSS на ней читается.

## Риск слома стиля и чем он сбит

[`prompt-stickers.md`](prompt-stickers.md) описывает, как лист 3×3 снёс стиль
целиком: пришёл плоский рисунок с бумажной фактурой. v1 этот риск сбил двумя
референсами, отсутствием слова `sticker` и прибитым кадрированием — и
[прогон 01.09 подтвердил](prompt-pack.md), что приём работает.

Здесь всё то же самое, плюс один новый риск: **три ячейки без персонажа.**
Лист, в котором тринадцать ячеек — собака, а три — лапа, модель охотно
«исправляет», дорисовывая морду. Поэтому запрет стоит трижды: в общем блоке
про лапу и отдельной строкой в каждой из трёх ячеек.

Если лапы придут с мордой (самый вероятный брак) — **лист не перегенерируется
целиком**. Три ячейки догоняются отдельной полосой 3×1 в той же сессии,
принятый лист третьим референсом:

```
python3 slice_grid.py paws.png --cols 3 --rows 1 \
  --names bully_helpful,bully_not_helpful,bully_detail --out out/
```

А вот если плоским придёт **весь лист** — резать нельзя, чинится только
перегенерацией, и правило v1 действует без изменений: тот же промпт двумя
листами 4×2 по восемь ячеек (`names-c1.txt`, `names-c2.txt`), меняется одна
строка сетки и длина списка, второй лист — в той же сессии, с принятым
первым третьим референсом.

---

## Промпт

Приложить **два** изображения: `bulli-ref.png` и `bully-style-ref.png`.
Просить **PNG в максимальном разрешении**, не JPEG: JPEG мылит границу
диска, и вырезание фона даёт кайму.

```
Both attached images show the same character. Keep him EXACTLY as he is in
them: the same 3D render, the same soft studio lighting, the same fur shading
and texture, the same huge glossy dark-brown eyes with the same white
highlights, the same freckled muzzle, the same big upright ears, the same worn
BLUE DENIM baseball cap with the white embroidered word "CROSS".

The second image is the approved reference for this set: match its style, its
lighting and its rendering exactly. Use it for STYLE ONLY — ignore its
keyboard, its pose and its crop, and do not put a keyboard in any cell.

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed emoji. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading on
the character. Every cell must look like the exact same 3D render as the
attached images, only in a different pose.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available. It is a strict 4 x 4 grid of 16 cells: sixteen equal square cells,
cells read left to right, top to bottom, cell 1 to cell 16.

BACKGROUND AND GRID: the whole canvas is one flat uniform medium grey
(#808080) — the gaps between the cells are that same grey, and the margin
around the outside of the grid is that same grey and half as wide as a gap.
Do NOT draw white lines between the cells. No cell borders, no frames, no grid
lines, no numbers, no captions, no labels, no watermark anywhere.

THE COLOURED DISC — this is the core of the set. In every cell the character
sits on one large flat CIRCLE of solid colour, centred in the cell. The circle
is the same size in all sixteen cells: its diameter is about 88% of the cell,
so a clear even ring of grey background stays visible all the way around it.
The circle is flat solid colour: no gradient, no glow, no gloss, no texture, no
outline, no ring, no shadow cast onto the grey background. Only the circle's
colour changes from cell to cell, exactly as listed per cell. Nothing may cross
or stick out over the edge of the circle — ears, paws and objects all stay
fully inside it.

THE CAP: in EVERY cell it is the same worn BLUE DENIM baseball cap — the same
shape, the same soft fabric, the same white embroidered word "CROSS" on the
front, big and clearly legible. The cap colour NEVER changes: in this set the
colour lives in the circle behind the character, never in the cap. The word
"CROSS" is the only text anywhere in the whole image: no other letters, no
other words. Marks that are symbols, not text — a check mark, a cross mark, an
exclamation mark, an arrow — are fine where listed.

FRAMING, identical in every cell that shows the dog: the character is seen from
the front at eye level, his head is LARGE and fills most of the circle, the eyes
stay the same huge size, and his chest runs off the lower edge of the circle so
that the circle crops him the way a round profile picture does. The camera
distance and the lighting are the same in every cell. Do NOT zoom out, do NOT
show a full body, do NOT make the head smaller in any cell. Only the pose, the
expression, the circle colour and the one object listed for that cell differ.

THE OBJECTS: where a cell lists an object, that object is WHITE — flat, matte,
pure white — and not the colour such a thing would normally be. It is big,
about half the height of the circle, simple and low on detail so that it still
reads when the cell is shrunk to 128 x 128 pixels. It sits beside the head, low
in the circle, it never covers the eyes or the cap, and it is the ONLY extra
object in that cell. Where a cell lists no object, that cell shows the
character alone on his coloured circle.

THREE CELLS SHOW A PAW INSTEAD OF THE DOG — cells 5, 6 and 7. In those three
there is NO head, NO face, NO eyes and NO cap at all. Each shows ONE front paw
of this same bulldog and nothing else: the same 3D render, the same cream fur
with the same shading, the same soft studio lighting, soft dark-brown paw pads,
a chunky rounded friendly paw that is clearly a DOG paw and not a human hand.
The paw is big and fills its circle the way the head fills it in the other
cells, and the leg runs off the lower edge of the circle.

The sixteen cells:

1. DEEP NAVY BLUE circle (#24406E). Chin lifted proudly, chest puffed up, wide
   happy open smile, one front paw raised beside the head in a confident
   presenting gesture. No object.
2. GREEN circle (#2E9E5B). Eyes closed in a satisfied happy smile, a big WHITE
   check mark beside the head, low in the circle.
3. RED circle (#D2453F). Ears drooping down, sad apologetic face, a big WHITE
   cross mark beside the head, low in the circle.
4. DEEP NAVY BLUE circle (#24406E). One front paw raised high beside the head
   waving hello, big warm open smile, ears perked up. No object.
5. GREEN circle (#2E9E5B). PAW CELL — no dog, no face, no cap in this cell.
   One bulldog front paw seen from the side, the toes curled into a soft fist
   and one toe stretched straight UP: a big clear thumbs-up made out of a dog
   paw. The paw fills the circle.
6. RED circle (#D2453F). PAW CELL — no dog, no face, no cap in this cell. The
   same bulldog front paw, turned over, the toes curled into a soft fist and
   one toe stretched straight DOWN: a big clear thumbs-down made out of a dog
   paw. The paw fills the circle.
7. DEEP NAVY BLUE circle (#24406E). PAW CELL — no dog, no face, no cap in this
   cell. The same bulldog front paw gripping a short thick WHITE pencil with a
   dark graphite tip, holding it tilted as if about to write. No paper, no
   notepad, no writing and no letters anywhere in the cell. The paw fills the
   circle.
8. DEEP NAVY BLUE circle (#24406E). Holding a big magnifying glass with a thick
   WHITE rim up in front of one eye, that eye hugely magnified through the clear
   lens, the other eye normal size, focused curious expression.
9. GREEN circle (#2E9E5B). Calm confident closed-mouth smile, eyes bright and
   steady, ears perked up, head straight. Nothing else in the circle at all: no
   object, no raised paws, no symbol. The green circle is the whole signal.
10. AMBER-ORANGE circle (#E09A2B). Head tilted to one side, one eyebrow raised
    higher than the other, mouth a small wavy unsure line, one ear up and one
    ear half down. Nothing else in the circle at all: no object, no raised paws,
    no symbol.
11. RED circle (#D2453F). Ears drooping flat, eyes lowered, mouth a small sad
    apologetic line, shoulders sunk. Nothing else in the circle at all: no
    object, no raised paws, no symbol.
12. MUTED BLUE-GREY circle (#7A879C). Completely blank puzzled expression, both
    eyebrows raised high, mouth slightly open, eyes wide and empty. Nothing else
    in the circle at all: no object, no raised paws, no symbol.
13. RED circle (#D2453F). Alarmed wide-open eyes, mouth open mid-bark, holding a
    small WHITE flag on a short white pole raised beside the head.
14. AMBER-ORANGE circle (#E09A2B). Worried expression, ears back, a big WHITE
    warning triangle beside the head with a bold amber exclamation mark cut out
    of it, low in the circle.
15. DEEP NAVY BLUE circle (#24406E). Holding a big closed WHITE padlock up just
    under the chin in both front paws, stern serious expression, one eyebrow
    raised.
16. DEEP NAVY BLUE circle (#24406E). Head turned slightly to one side, one front
    paw raised pointing off to that side, a big WHITE arrow beside the head
    pointing the same way, ears perked up high.
```

## Что в ячейках

Порядок чтения — слева направо, сверху вниз; он же порядок в `names-c.txt`,
и он **тот же, что в v1**. Строки сгруппированы по смыслу: разъехавшаяся
строка перегенерируется одна листом 4×1, не трогая остальные.

| # | имя | диск | субъект | предмет | что показывает |
|---|---|---|---|---|---|
| 1 | `bully_ready` | тёмно-синий | морда | — | ответ готов |
| 2 | `bully_done` | зелёный | морда | белая галка | решено |
| 3 | `bully_fail` | красный | морда | белый крест | закрыто нерешённым |
| 4 | `bully_hi` | тёмно-синий | морда | — | приветствие в личке |
| 5 | `bully_helpful` | зелёный | **лапа** | — | «помогло» |
| 6 | `bully_not_helpful` | красный | **лапа** | — | «не помогло» |
| 7 | `bully_detail` | тёмно-синий | **лапа** | белый карандаш | «написать подробнее» |
| 8 | `bully_search` | тёмно-синий | морда | белая лупа | пошёл в каталог DD |
| 9 | `bully_high` | зелёный | морда | — | уверенность высокая |
| 10 | `bully_mid` | янтарный | морда | — | уверенность средняя |
| 11 | `bully_none` | красный | морда | — | ответа в базе нет |
| 12 | `bully_unknown` | сине-серый | морда | — | формат ответа не разобран |
| 13 | `bully_flag` | красный | морда | белый флажок | поломка, чинить |
| 14 | `bully_warn` | янтарный | морда | белый треугольник | предупреждение |
| 15 | `bully_lock` | тёмно-синий | морда | белый замок | согласование ИБ |
| 16 | `bully_expert` | тёмно-синий | морда | белая стрелка | позвать эксперта |

Что в лист по-прежнему **не вошло**: `🔢`, `🔗`, `🗂`, `🔁`, `✂️` и
человеческая пачка B (`bully_facepalm`, `bully_thanks`, `bully_wait`,
`bully_nothing`, `bully_idea`). Причина та же, что в v1, — места на листе,
а не смысла.

## Что проверить до нарезки

Первые пять пунктов — новые, они про v2. Остальные унаследованы от v1
и там же объяснены.

- **три ячейки обратной связи — лапа без морды.** Дорисованная морда
  в 5, 6 или 7 — переделка полосой 3×1, нарезкой не чинится;
- **жест лапы читается**: вверх в 5, вниз в 6. Перепутанные местами дают
  кнопку, которая врёт про оценку;
- **кепка синяя джинсовая во всех тринадцати ячейках с мордой.** Цветная
  кепка на цветном диске — возврат к v1 и каша на 22 px;
- **предметы белые.** Зелёная галка на зелёном диске не видна вовсе;
- **диски одного размера, ровно круглые, залиты плоско** и не выходят
  за края ячейки; вокруг каждого — серое кольцо;
- **промежутки между ячейками серые, а не белые.** Белых полос в v1
  просили не делать — и они пришли; если пришли снова, `sheet.find_gaps`
  их поймает, но по краю прозрачного PNG останется белая кайма;
- **надпись CROSS на месте и белая** во всех ячейках с мордой;
- **третья строка без предметов** — иначе светофор перестал отличаться
  от вердиктов;
- **глаза того же размера, что в референсе, и рендер объёмный** — уехавшие
  глаза и бумажная фактура — тот самый слом стиля;
- **клавиатуры нет ни в одной ячейке** — второй референс тащит её за стилем.

## Нарезка

Команда и имена — те же, что в v1:

```
python3 slice_grid.py sheet-d.png --cols 4 --rows 4 --names names-c.txt --out out/
```

Разделители теперь просят серыми, поэтому `sheet.find_gaps` их не найдёт
и поделит лист **ровно** — это штатный путь, а не отказ. Ровное деление
верно ровно при одном условии: **внешнее поле листа равно половине
промежутка между ячейками** (иначе `S/4` не совпадёт с шагом сетки). Оно
и стоит в промпте. Если модель поле не выдержала и в ячейку заехал край
соседнего диска, лист правится до нарезки — обрезать внешние поля так,
чтобы они стали половиной промежутка:

```
python3 -c "from PIL import Image; im=Image.open('sheet-d.png'); \
im.crop((L,T,R,B)).save('sheet-d.png')"
```

Запас на это есть: диск занимает 88% ячейки, то есть 6% ширины ячейки
свободны с каждой стороны.

## Заливка в Mattermost

Имена те же — и это единственное место, где переделка стоит лишнего шага:
**Mattermost не даёт заменить картинку у существующего кастомного эмодзи.**
Старый `:bully_done:` придётся сначала удалить (Main menu → Custom Emoji →
найти → Delete), и только потом залить новый файл под тем же именем.

Порядок на все шестнадцать: удалить старое имя → залить новое → проверить
в плашке реакции. Пока имя удалено и не залито, посты с этой реакцией
показывают голый `:bully_done:` — поэтому по одному, а не «удалить все
шестнадцать, потом залить шестнадцать».

## Код

**Ничего.** Имена эмодзи не менялись, таблица подстановок из
[`prompt-pack.md`](prompt-pack.md), раздел «Где это живёт в коде», остаётся
верной целиком — вместе с тремя её предупреждениями (словарь телеметрии
привязан к именам; `🔒` внутри черновика не трогать; кнопки проверяются
одной живой кнопкой).
