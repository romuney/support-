# Задание Nano Banana: пак v2 — диск с лучами (16 эмодзи)

Переделка [`prompt-pack.md`](prompt-pack.md) после того, как пак v1 пожил
в канале. Состав, имена и порядок ячеек те же — меняется **композиция**:
под персонажа встаёт цветной диск с лучами, а три иконки обратной связи
перестают быть мордой и становятся лапой.

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

**1. Под персонажа встаёт диск с лучами.** Плоское солнце: сплошной круг
и прямые треугольные лучи от него во все стороны. Кепка при этом **цвет
сохраняет** — диск её не заменяет, а усиливает: тот же вердикт занимает
теперь не четверть кадра, а почти весь. Лучи добавлены не для красоты —
они дотягивают заливку до углов квадрата, которые круг оставляет пустыми,
и дают силуэт, узнаваемый даже пятном.

**2. Три тона одной краски.** Диск — тёмный, лучи — средний, кепка —
светлый. Взять диск и кепку одного тона нельзя: кепка на нём пропадёт,
а она главный опознавательный признак персонажа.

**3. Предметы становятся белыми.** Зелёная галка v1 на тёмно-зелёном диске
не видна, и это относится ко всем шести предметам сразу. Белый читается
на любом из пяти цветов палитры.

**4. Три ячейки обратной связи — лапа, а не морда, и без диска.**
`bully_helpful`, `bully_not_helpful`, `bully_detail` живут на кнопках и
в подтверждении, где рядом стоит подпись и места на портрет нет. Там нужен
**привычный жест**: палец вверх, палец вниз, «записываю». Жест делает лапа
нашего бульдожки, и она занимает весь кадр целиком — диск ей не нужен,
он бы только отобрал у жеста площадь.

Что при этом **не меняется**: сам персонаж, рендер, свет, глаза, надпись
CROSS, цвета кепок из v1, серый фон листа, набор из шестнадцати имён
и порядок ячеек.

## Правило пака v2: диск — как прошло, предмет — что случилось

| канал | что кодирует | почему |
|---|---|---|
| **цвет диска с лучами** | исход: зелёный — ок, янтарный — с оговорками, красный — не ок, сине-серый — непонятно, тёмно-синий — просто работа | заливка во весь кадр — единственное, что переживает уменьшение до 22 px |
| **цвет кепки** | тот же исход, тем же цветом посветлее | признак персонажа, оставшийся от v1; на 128 px подтверждает вердикт вблизи |
| **субъект** | морда — про обращение и уверенность, лапа — про оценку ответа человеком | две семьи не путаются между собой даже пятном |
| **белый предмет** | событие: галка, крест, лупа, замок, стрелка, флажок, треугольник | работает на 128 px, когда человек навёл курсор или открыл список эмодзи |

**Четыре ячейки третьей строки — без предмета вовсе.** Это светофор
уверенности (`🟢 🟡 🔴 ⚪` в шапке ответа), и там диск — весь сигнал.
Пустой диск отличает их от вердиктов: `bully_done` — зелёный диск И белая
галка, `bully_high` — просто зелёный диск. Правило из v1, и оно осталось
верным: на 22 px эти пары различаются только наличием предмета.

## Палитра: три тона, и ни один не серый

Цвета кепок замерены по существующим иконкам из `out/` — это ровно то,
что модель уже умеет рисовать, и просить в промпте надо его же.

| роль | диск (тёмный) | лучи (средний) | кепка (светлый, как в v1) |
|---|---|---|---|
| ок | `#17583A` | `#2E9E5B` | `#698366` зелёная |
| с оговорками | `#9A6412` | `#E09A2B` | `#D59F5E` янтарная |
| не ок | `#7E241F` | `#D2453F` | `#CB5251` красная |
| просто работа | `#1B3358` | `#2F5288` | `#596B88` синяя джинсовая |
| непонятно | `#4F5A6E` | `#74829A` | `#BAB5B1` светло-серая |

Разница по яркости диск↔кепка держится в 50–90 единиц: меньше — и кепка
на диске тонет.

**Ни один диск не может быть нейтрально-серым.** Фон снимается по признаку
«нейтральный серый» (`sheet.key_background`, порог `SAT_MAX = 12`), поэтому
серый диск для `bully_unknown` — тот, что напрашивается по аналогии
со светло-серой кепкой, — вырежется вместе с фоном. Проверено синтетической
ячейкой: с жёстким краем серый диск выживает (заливку останавливает перепад
яркости на границе), но у рендера край мягкий всегда, и тогда — нет.

| диск | край жёсткий | край мягкий 1.5 px | край мягкий 3 px |
|---|---|---|---|
| цветной (любой из пяти) | цел | цел | цел |
| `#A0A0A0` серый | цел | цел | **съеден** |
| `#8A8A8A` серый | цел | **съеден** | **съеден** |

Отсюда правило на будущее: **любой новый цвет диска — не серый, разница
между максимальным и минимальным каналом не меньше 30.** У сине-серого
`#4F5A6E` она 31, и это самый близкий к серому цвет, который можно себе
позволить.

**Светло-серая кепка `bully_unknown` при этом стала безопасной.** В v1 она
была отдельной бедой: нейтральная не хуже фона, она пускала заливку внутрь
по шву и оставалась с прозрачными трещинами (разбор — в
[`prompt-pack.md`](prompt-pack.md)). Теперь она целиком окружена цветным
диском, заливка от края кадра до неё не доходит вовсе. Проверено на той же
синтетической ячейке: дырок в серой кепке внутри диска — ноль на всех пяти
цветах.

## Риск слома стиля и чем он сбит

[`prompt-stickers.md`](prompt-stickers.md) описывает, как лист 3×3 снёс стиль
целиком: пришёл плоский рисунок с бумажной фактурой. v1 этот риск сбил двумя
референсами, отсутствием слова `sticker` и прибитым кадрированием — и
[прогон 01.09 подтвердил](prompt-pack.md), что приём работает.

Здесь всё то же самое, плюс два новых риска.

**Плоское солнце рядом с объёмным персонажем.** Диск и лучи — плоская
геометрия, и модель может «согласовать» их с персонажем в обратную
сторону: сделать плоским его. Поэтому в промпте плоскость разрешена
диску явно и только ему, а про персонажа отдельной строкой сказано, что
он остаётся тем же 3D-рендером.

**Три ячейки без персонажа.** Лист, в котором тринадцать ячеек — собака,
а три — лапа, модель охотно «исправляет», дорисовывая морду. Запрет стоит
трижды: в общем блоке про лапу и отдельной строкой в каждой из трёх ячеек.

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
лучей, и вырезание фона даёт кайму.

```
Both attached images show the same character. Keep him EXACTLY as he is in
them: the same 3D render, the same soft studio lighting, the same fur shading
and texture, the same huge glossy dark-brown eyes with the same white
highlights, the same freckled muzzle, the same big upright ears, the same worn
denim baseball cap with the white embroidered word "CROSS".

The second image is the approved reference for this set: match its style, its
lighting and its rendering exactly. Use it for STYLE ONLY — ignore its
keyboard, its pose and its crop, and do not put a keyboard in any cell.

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed emoji. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading on
the character. Every cell must show the exact same 3D render as the attached
images, only in a different pose.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available. It is a strict 4 x 4 grid of 16 cells: sixteen equal square cells,
cells read left to right, top to bottom, cell 1 to cell 16.

BACKGROUND AND GRID: the whole canvas is one flat uniform medium grey
(#808080) — the gaps between the cells are that same grey, and the margin
around the outside of the grid is that same grey and half as wide as a gap.
Do NOT draw white lines between the cells. No cell borders, no frames, no grid
lines, no numbers, no captions, no labels, no watermark anywhere.

THE SUNBURST — this is the new part of the set, and it appears in thirteen of
the sixteen cells. Behind the character there is a flat two-tone sunburst: a
solid filled CIRCLE, and sixteen short straight triangular RAYS pointing
outward from behind it, evenly spaced all the way around, like a simple
comic-book radial burst. The circle's diameter is about 62% of the cell and the
ray tips reach about 92% of it, so a clear even ring of grey background stays
visible around the whole sunburst.

The sunburst is FLAT graphic shape — flat solid colour, no gradient, no glow,
no gloss, no texture, no outline, no drop shadow, no 3D. This flatness applies
to the sunburst ONLY: the dog in front of it stays the same fully 3D rendered
character as in the attached images. The sunburst is the same shape and the
same size in every one of those thirteen cells — only its two colours change,
exactly as listed per cell: the circle takes the DARK tone and the rays take
the MIDDLE tone of the same colour.

THE CAP: in every cell that shows the dog it is the same worn denim baseball
cap, the same shape, the same soft fabric, with the same white embroidered word
"CROSS" on the front, big and clearly legible. ONLY the dye colour of the
fabric changes, exactly as listed per cell — always the LIGHT tone of the same
colour as the sunburst behind it, so that the cap stays clearly visible against
the darker circle. The embroidery stays white and readable on every colour. The
word "CROSS" is the only text anywhere in the whole image: no other letters, no
other words. Marks that are symbols, not text — a check mark, a cross mark, an
exclamation mark, an arrow — are fine where listed.

FRAMING, identical in every cell that shows the dog: the character is seen from
the front at eye level, he stands IN FRONT of the sunburst, his head is LARGE
and fills the solid circle almost completely, the eyes stay the same huge size,
and his chest may overlap the lower rays. Nothing of him — not his ears, not
his paws, not the object — may stick out past the tips of the rays. The camera
distance and the lighting are the same in every cell. Do NOT zoom out, do NOT
show a full body, do NOT make the head smaller in any cell.

THE OBJECTS: where a cell lists an object, that object is WHITE — flat, matte,
pure white — and not the colour such a thing would normally be. It is big,
about half the height of the circle, simple and low on detail so that it still
reads when the cell is shrunk to 128 x 128 pixels. It sits beside the head, low
in the cell, it never covers the eyes or the cap, and it is the ONLY extra
object in that cell. Where a cell lists no object, that cell shows the
character alone in front of his sunburst.

THREE CELLS SHOW A PAW AND NOTHING ELSE — cells 5, 6 and 7. In those three
there is NO head, NO face, NO eyes, NO cap — AND NO SUNBURST: no circle and no
rays either. Each of them shows ONE front paw of this same bulldog alone on the
plain grey background. The paw is rendered in exactly the same way as the dog:
the same 3D render, the same cream fur with the same shading, the same soft
studio lighting, soft dark-brown paw pads. It is a chunky, rounded, friendly
paw that is clearly a DOG paw and not a human hand. It is BIG — it fills its
cell the way the head fills the circle in the other cells, with only a small
even margin of grey around it, and it does not touch the edges of its cell.

The sixteen cells:

1. Blue denim cap (#596B88). Sunburst: dark navy circle (#1B3358), mid navy
   rays (#2F5288). Chin lifted proudly, chest puffed up, wide happy open smile,
   one front paw raised beside the head in a confident presenting gesture. No
   object.
2. GREEN cap (#698366). Sunburst: dark green circle (#17583A), mid green rays
   (#2E9E5B). Eyes closed in a satisfied happy smile, a big WHITE check mark
   beside the head, low in the cell.
3. RED cap (#CB5251). Sunburst: dark red circle (#7E241F), mid red rays
   (#D2453F). Ears drooping down, sad apologetic face, a big WHITE cross mark
   beside the head, low in the cell.
4. Blue denim cap (#596B88). Sunburst: dark navy circle (#1B3358), mid navy
   rays (#2F5288). One front paw raised high beside the head waving hello, big
   warm open smile, ears perked up. No object.
5. PAW CELL — no dog, no face, no cap, no sunburst, no circle, no rays. One
   bulldog front paw seen from the side on the plain grey background, the toes
   curled into a soft fist and one toe stretched straight UP: a big clear
   thumbs-up made out of a dog paw. It fills the cell.
6. PAW CELL — no dog, no face, no cap, no sunburst, no circle, no rays. The
   same bulldog front paw, turned over, the toes curled into a soft fist and
   one toe stretched straight DOWN: a big clear thumbs-down made out of a dog
   paw. It fills the cell.
7. PAW CELL — no dog, no face, no cap, no sunburst, no circle, no rays. The
   same bulldog front paw gripping a short thick yellow pencil with a dark
   graphite tip, holding it tilted as if about to write. No paper, no notepad,
   no writing and no letters anywhere in the cell. It fills the cell.
8. Blue denim cap (#596B88). Sunburst: dark navy circle (#1B3358), mid navy
   rays (#2F5288). Holding a big magnifying glass with a thick WHITE rim up in
   front of one eye, that eye hugely magnified through the clear lens, the other
   eye normal size, focused curious expression.
9. GREEN cap (#698366). Sunburst: dark green circle (#17583A), mid green rays
   (#2E9E5B). Calm confident closed-mouth smile, eyes bright and steady, ears
   perked up, head straight. Nothing else in the cell at all: no object, no
   raised paws, no symbol. The green sunburst is the whole signal.
10. AMBER cap (#D59F5E). Sunburst: dark amber circle (#9A6412), mid amber rays
    (#E09A2B). Head tilted to one side, one eyebrow raised higher than the
    other, mouth a small wavy unsure line, one ear up and one ear half down.
    Nothing else in the cell at all: no object, no raised paws, no symbol.
11. RED cap (#CB5251). Sunburst: dark red circle (#7E241F), mid red rays
    (#D2453F). Ears drooping flat, eyes lowered, mouth a small sad apologetic
    line, shoulders sunk. Nothing else in the cell at all: no object, no raised
    paws, no symbol.
12. Plain LIGHT GREY cap (#BAB5B1), washed out and unpainted. Sunburst: dark
    blue-grey circle (#4F5A6E), mid blue-grey rays (#74829A). Completely blank
    puzzled expression, both eyebrows raised high, mouth slightly open, eyes
    wide and empty. Nothing else in the cell at all: no object, no raised paws,
    no symbol.
13. RED cap (#CB5251). Sunburst: dark red circle (#7E241F), mid red rays
    (#D2453F). Alarmed wide-open eyes, mouth open mid-bark, holding a small
    WHITE flag on a short white pole raised beside the head.
14. AMBER cap (#D59F5E). Sunburst: dark amber circle (#9A6412), mid amber rays
    (#E09A2B). Worried expression, ears back, a big WHITE warning triangle
    beside the head with a bold dark exclamation mark inside it, low in the cell.
15. Blue denim cap (#596B88). Sunburst: dark navy circle (#1B3358), mid navy
    rays (#2F5288). Holding a big closed WHITE padlock up just under the chin in
    both front paws, stern serious expression, one eyebrow raised.
16. Blue denim cap (#596B88). Sunburst: dark navy circle (#1B3358), mid navy
    rays (#2F5288). Head turned slightly to one side, one front paw raised
    pointing off to that side, a big WHITE arrow beside the head pointing the
    same way, ears perked up high.
```

## Что в ячейках

Порядок чтения — слева направо, сверху вниз; он же порядок в `names-c.txt`,
и он **тот же, что в v1**. Строки сгруппированы по смыслу: разъехавшаяся
строка перегенерируется одна листом 4×1, не трогая остальные.

| # | имя | цвет | субъект | предмет | что показывает |
|---|---|---|---|---|---|
| 1 | `bully_ready` | синий | морда на диске | — | ответ готов |
| 2 | `bully_done` | зелёный | морда на диске | белая галка | решено |
| 3 | `bully_fail` | красный | морда на диске | белый крест | закрыто нерешённым |
| 4 | `bully_hi` | синий | морда на диске | — | приветствие в личке |
| 5 | `bully_helpful` | — | **лапа, без диска** | — | «помогло» |
| 6 | `bully_not_helpful` | — | **лапа, без диска** | — | «не помогло» |
| 7 | `bully_detail` | — | **лапа, без диска** | жёлтый карандаш | «написать подробнее» |
| 8 | `bully_search` | синий | морда на диске | белая лупа | пошёл в каталог DD |
| 9 | `bully_high` | зелёный | морда на диске | — | уверенность высокая |
| 10 | `bully_mid` | янтарный | морда на диске | — | уверенность средняя |
| 11 | `bully_none` | красный | морда на диске | — | ответа в базе нет |
| 12 | `bully_unknown` | сине-серый | морда на диске | — | формат ответа не разобран |
| 13 | `bully_flag` | красный | морда на диске | белый флажок | поломка, чинить |
| 14 | `bully_warn` | янтарный | морда на диске | белый треугольник | предупреждение |
| 15 | `bully_lock` | синий | морда на диске | белый замок | согласование ИБ |
| 16 | `bully_expert` | синий | морда на диске | белая стрелка | позвать эксперта |

Карандаш в седьмой ячейке — единственный предмет, оставшийся цветным:
он в лапе, а не на диске, белого фона под ним нет, и белый карандаш
на светлой теме исчез бы вместе с фоном.

Что в лист по-прежнему **не вошло**: `🔢`, `🔗`, `🗂`, `🔁`, `✂️` и
человеческая пачка B (`bully_facepalm`, `bully_thanks`, `bully_wait`,
`bully_nothing`, `bully_idea`). Причина та же, что в v1, — места на листе,
а не смысла.

## Что проверить до нарезки

Первые шесть пунктов — новые, они про v2. Остальные унаследованы от v1
и там же объяснены.

- **три ячейки обратной связи — лапа без морды и без диска.** Дорисованная
  морда или солнце в 5, 6 или 7 — переделка полосой 3×1, нарезкой не чинится;
- **жест лапы читается**: вверх в 5, вниз в 6. Перепутанные местами дают
  кнопку, которая врёт про оценку;
- **персонаж остался объёмным.** Плоское солнце рядом с ним — приглашение
  сделать плоским и его; если рендер поплыл, это слом стиля, а не мелочь;
- **диск и лучи одного размера во всех тринадцати ячейках**, залиты плоско,
  без градиента и тени, и не выходят за края ячейки; вокруг — серое кольцо;
- **кепка видна на диске.** Диск обязан быть заметно темнее её: тон в тон —
  и кепка вместе с надписью CROSS растворяется;
- **предметы белые** (кроме карандаша в лапе). Зелёная галка на тёмно-зелёном
  диске ещё видна, а вот на среднем луче — уже нет;
- **промежутки между ячейками серые, а не белые.** Белых полос в v1
  просили не делать — и они пришли; если пришли снова, `sheet.find_gaps`
  их поймает, но по краю прозрачного PNG останется белая кайма;
- **надпись CROSS на месте и белая** во всех тринадцати ячейках с мордой —
  на перекрашенной кепке модель теряет её первой;
- **третья строка без предметов** — иначе светофор перестал отличаться
  от вердиктов;
- **глаза того же размера, что в референсе** — уехавшие глаза и бумажная
  фактура — тот самый слом стиля;
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
и стоит в промпте. Если модель поле не выдержала и в ячейку заехал луч
соседнего солнца, лист правится до нарезки — обрезать внешние поля так,
чтобы они стали половиной промежутка:

```
python3 -c "from PIL import Image; im=Image.open('sheet-d.png'); \
im.crop((L,T,R,B)).save('sheet-d.png')"
```

Запас на это есть: лучи занимают 92% ячейки, то есть 4% ширины свободны
с каждой стороны. Запас вдвое меньше, чем у голого круга, — с лучами
за полями следить внимательнее.

Три ячейки с лапой обрезаются по силуэту лапы, а не по солнцу: `content_box`
у каждой ячейки свой, и лапа сама растянется на все 128 px. Отдельной
команды для них не нужно — это то же самое `fit_square`.

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
