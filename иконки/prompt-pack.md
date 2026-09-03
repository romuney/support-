# Задание Nano Banana: весь пак одним листом (16 эмодзи)

> **Это v1, прогон 01.09 — залит в Mattermost и переделывается.** Запускать
> нужно [`prompt-pack-v2.md`](prompt-pack-v2.md): там тот же состав и те же
> имена, но цвет вынесен из кепки в фон-диск, а обратная связь стала лапой.
> Причины переделки — в разделе «Что не так с v1» там же. Здесь остаётся
> разбор прогона v1 и **таблица «Где это живёт в коде», которая верна
> по-прежнему**: имена эмодзи v2 не меняет.

Один промпт, один лист 4×4, шестнадцать иконок в едином стиле. Нарезка —
`slice_grid.py`, команда в конце файла.

Пак собран не по фантазии, а по тому, **что реально печатает бот и чем
размечает канал дежурный**: каждой ячейке соответствует юникод-эмодзи или
реакция, живущая в коде. Таблица соответствий — в конце, раздел
«Где это живёт в коде».

Уже сгенерировано и работает: **`bully_work`** — GIF «бот печатает»
(`out/bulli_typing.gif`, задание в [`prompt-typing-gif.md`](prompt-typing-gif.md)).
Его стиль и есть эталон для этого листа, поэтому он прикладывается вторым
референсом.

---

## Правило пака: кепка — как прошло, предмет — что случилось

Два независимых канала смысла, и в этом вся идея пака.

| канал | что кодирует | почему так |
|---|---|---|
| **цвет кепки** | исход: зелёная — ок, жёлтая — с оговорками, красная — не ок, светло-серая — непонятно | цвет читается на 128×128 первым и целиком, до того как глаз разобрал предмет в лапах |
| **предмет в кадре** | событие: галка, крест, лупа, замок, стрелка, флажок | предмет отвечает на «что именно», но на плашке реакции он мелкий |

Синяя джинсовая кепка — состояние по умолчанию, «просто работа»: в семи
ячейках из шестнадцати она остаётся такой, как на референсе. Цвет включается
только там, где иконка выносит **вердикт**. Если перекрасить все шестнадцать,
цвет перестанет что-либо значить, а персонаж перестанет быть узнаваемым:
кепка с надписью CROSS — главный опознавательный признак, сильнее морды.

Отсюда же требование к промпту, которое проверять первым: **надпись CROSS
белая и читаемая на всех шестнадцати кепках, какого бы цвета кепка ни была.**
Модель теряет надпись чаще всего, а на перекрашенной кепке — тем более.

**Четыре ячейки третьей строки — без предмета вовсе.** Это светофор
уверенности (`🟢 🟡 🔴 ⚪` в шапке ответа бота), и там цвет кепки — весь
сигнал. Пустые лапы отличают их от ячеек с вердиктом: `bully_done` — зелёная
кепка И галка, `bully_high` — просто зелёная кепка. Без этого правила
на плашке 128×128 они слились бы.

## Лист, а не по одному — и чем сбит риск

[`prompt-stickers.md`](prompt-stickers.md) описывает, как лист 3×3 снёс стиль:
пришёл плоский рисунок с бумажной фактурой вместо 3D-рендера. Причины там же:
слово `sticker`, девять новых поз за один прогон, просьба показать персонажа
во весь рост при портретном референсе.

Здесь лист всё равно нужен: шестнадцать поштучных прогонов дают шестнадцать
слегка разных персонажей, а пак обязан выглядеть одним набором. Риск сбит
четырьмя приёмами:

1. **Два референса вместо одного.** Первый — `bulli-ref.png` (исходный
   портрет), второй — `bully-style-ref.png` (кадр из ПРИНЯТОГО листа
   анимации, тот самый стиль, который дошёл до Mattermost живым).
   Два образца одного стиля сужают пространство сильнее, чем один образец
   плюс описание словами.
2. **Слова `sticker` в промпте нет ни разу** — ни в задании, ни в проверках.
3. **Кадрирование прибито гвоздями**: тот же портрет, та же огромность глаз,
   голова во весь кадр, тела почти нет. Про полный рост не просим нигде.
4. **Меняется мало.** Поза и предмет — да, но морда, свет, шерсть, ракурс
   и масштаб описаны как неизменные, а не подразумеваются.

Если лист всё же придёт плоским — **резать нельзя, чинится только
перегенерацией**. Тогда тот же промпт запускается двумя листами 4×2
по восемь ячеек (`names-c1.txt`, `names-c2.txt`): меняется одна строка
сетки и длина списка, всё остальное слово в слово. Второй лист в той же
сессии, с принятым первым листом третьим референсом.

---

## Промпт

Приложить **два** изображения: `bulli-ref.png` и `bully-style-ref.png`.
Просить **PNG в максимальном разрешении**, не JPEG: JPEG мылит границу
силуэта, и вырезание фона даёт кайму.

```
Both attached images show the same character. Keep him EXACTLY as he is in
them: the same 3D render, the same soft studio lighting, the same fur shading
and texture, the same huge glossy dark-brown eyes with the same white
highlights, the same head-to-body proportions with the head filling most of the
frame, the same freckled muzzle, the same big upright ears, the same worn denim
baseball cap with the white embroidered word "CROSS".

The second image is the approved reference for this set: match its style, its
lighting and its background exactly. Use it for STYLE ONLY — ignore its
keyboard, its pose and its crop, and do not put a keyboard in any cell.

Do NOT redraw him. Do NOT restyle him. Do NOT turn him into a 2D illustration,
a painted cartoon, a vector drawing or a printed emoji. No paper texture, no
canvas texture, no glossy print finish, no outline drawing, no flat shading.
Every cell must look like the exact same 3D render as the attached images, only
in a different pose.

Output ONE single square image, 1:1 aspect ratio, at the highest resolution
available. It is a strict 4 x 4 grid of 16 versions of this same character:
sixteen equal square cells, equal outer margins, a uniform gap between cells,
cells read left to right, top to bottom, cell 1 to cell 16. No cell borders, no
frames, no grid lines, no numbers, no captions, no labels, no watermark.

FRAMING, identical in all sixteen cells: the character is seen from the front at
eye level, the head fills most of the cell, the eyes stay the same huge size,
the camera distance and the lighting are the same in every cell. Do NOT zoom
out, do NOT show a full body, do NOT make the head smaller in any cell. Only the
pose, the expression, the cap colour and the one object listed for that cell are
allowed to differ.

THE CAP: in every cell it is the same worn denim baseball cap, the same shape,
the same soft fabric, with the same white embroidered word "CROSS" on the front,
big and clearly legible. ONLY the dye colour of the fabric changes, exactly as
listed per cell. The embroidery stays white and readable on every colour. The
word "CROSS" is the only text anywhere in the whole image: no other letters, no
other words. Marks that are symbols, not text — a check mark, a cross mark, an
exclamation mark inside a warning triangle, an arrow — are fine where listed.

THE OBJECTS: where a cell lists an object, it is big, simple and low detail so
that it stays readable when the cell is shrunk to 128 x 128 pixels. It sits
beside the head or enters the cell from the bottom edge, it never covers the
eyes or the cap, and it is the ONLY extra object in that cell. Where a cell says
nothing else, the cell contains the character alone.

BACKGROUND: one flat uniform medium grey (#808080) filling the entire canvas
including the gaps between the cells. No gradient, no vignette, no ground
shadow, no reflections, no ground plane. Leave a clear empty margin of
background around the character inside every cell: neither the dog, nor his
ears, nor his raised paws, nor the object may touch or run off the edges of
their cell.

The sixteen cells:

1. Blue denim cap. Chin lifted proudly, chest puffed up, wide happy open smile,
   one front paw raised into the bottom of the cell in a confident presenting
   gesture. Nothing else in the cell.
2. GREEN denim cap. Eyes closed in a satisfied happy smile, a huge bright green
   check mark beside the head, as tall as the head itself.
3. RED denim cap. Ears drooping down, sad apologetic face, a huge bright red
   cross mark beside the head, as tall as the head itself.
4. Blue denim cap. One front paw raised high beside the head waving hello, big
   warm open smile, ears perked up. Nothing else in the cell.
5. GREEN denim cap. One front paw raised into the cell beside the head giving a
   big thumbs-up, one eye winking, cheerful grin.
6. RED denim cap. One front paw raised into the cell beside the head giving a
   big thumbs-down, mouth a small sorry line, ears half down.
7. Blue denim cap. Holding a short thick yellow pencil upright in one front paw
   beside the head and a small blank white notepad in the other front paw,
   attentive helpful expression, ready to write. The notepad is blank: no
   writing, no lines, no letters on it.
8. Blue denim cap. Holding a big magnifying glass up in front of one eye, that
   eye hugely magnified through the lens, the other eye normal size, focused
   curious expression.
9. GREEN denim cap. Calm confident closed-mouth smile, eyes bright and steady,
   ears perked up, head straight. Nothing else in the cell at all: no object, no
   raised paws, no symbol. The green cap is the whole signal.
10. AMBER-YELLOW denim cap. Head tilted to one side, one eyebrow raised higher
    than the other, mouth a small wavy unsure line, one ear up and one ear half
    down. Nothing else in the cell at all: no object, no raised paws, no symbol.
11. RED denim cap. Ears drooping flat, eyes lowered, mouth a small sad
    apologetic line, shoulders sunk. Nothing else in the cell at all: no object,
    no raised paws, no symbol.
12. Plain LIGHT GREY denim cap, washed out and unpainted. Completely blank
    puzzled expression, both eyebrows raised high, mouth slightly open, eyes
    wide and empty. Nothing else in the cell at all: no object, no raised paws,
    no symbol.
13. RED denim cap. Alarmed wide-open eyes, mouth open mid-bark, holding a small
    bright red flag on a short pole raised beside the head.
14. AMBER-YELLOW denim cap. Worried expression, ears back, a big bright yellow
    warning triangle with a bold black exclamation mark inside it beside the
    head, as tall as the head itself.
15. Blue denim cap. Holding a big closed golden padlock up just under the chin
    in both front paws, stern serious expression, one eyebrow raised.
16. Blue denim cap. Head turned slightly to one side, one front paw raised
    pointing off to that side, a big bold yellow arrow beside the head pointing
    the same way, ears perked up high.
```

## Что в ячейках

Порядок чтения — слева направо, сверху вниз; он же порядок в `names-c.txt`.
Строки сгруппированы по смыслу: если разъехалась одна строка, перегенерировать
можно её одну листом 4×1, не трогая остальные.

| # | имя | кепка | что показывает | что заменяет |
|---|---|---|---|---|
| 1 | `bully_ready` | синяя | ответ готов, гордая поза | — (снимается `bully_work`) |
| 2 | `bully_done` | **зелёная** | решено, зелёная галка | реакция `:done_checkmark:` |
| 3 | `bully_fail` | **красная** | закрыто нерешённым, красный крест | реакция `:im_red_cross:` |
| 4 | `bully_hi` | синяя | приветствие в личке | — |
| 5 | `bully_helpful` | **зелёная** | «помогло» | 👍 на кнопке и в подтверждении |
| 6 | `bully_not_helpful` | **красная** | «не помогло» | 👎 там же |
| 7 | `bully_detail` | синяя | «написать подробнее» | ✍️ там же |
| 8 | `bully_search` | синяя | пошёл в каталог DD | — |
| 9 | `bully_high` | **зелёная** | уверенность высокая | 🟢 в шапке ответа |
| 10 | `bully_mid` | **жёлтая** | уверенность средняя | 🟡 там же |
| 11 | `bully_none` | **красная** | ответа в базе нет | 🔴 там же |
| 12 | `bully_unknown` | **светло-серая** | формат ответа не разобран | ⚪ там же |
| 13 | `bully_flag` | **красная** | поломка, чинить | 🚩 в служебном блоке |
| 14 | `bully_warn` | **жёлтая** | предупреждение | ⚠️ там же |
| 15 | `bully_lock` | синяя | согласование ИБ, закрытые поля | 🔒 **только в служебном блоке**, см. ниже |
| 16 | `bully_expert` | синяя | позвать эксперта по теме | 🧭 там же |

Что в лист **не вошло** и ждёт второго прогона: `🔢` (сверка значений),
`🔗` (юнит по ссылке), `🗂` (каталог без состава), `🔁` (путь по реестру),
`✂️` (черновик обрезан) — и человеческая пачка B (`bully_facepalm`,
`bully_thanks`, `bully_wait`, `bully_nothing`, `bully_idea`). Все пять
маркеров печатаются в служебном блоке единицами раз против семнадцати
у `🚩` — на первом листе места им не хватило, а не смысла.

## Что пришло с прогона 2026-09-01

**Лист принят, все шестнадцать иконок нарезаны** и лежат в `out/`. Сам лист —
`sheet-c.jpg` (4096×4096, пережат в JPEG q85 ради веса в git; нарезка из него
даёт ровно то, что лежит в `out/` — файлы оттуда и получены).

Стиль устоял: 3D-рендер, глаза того же размера, CROSS на всех шестнадцати
кепках, цвета кепок ровно по таблице, третья строка без предметов. То есть
приём с двумя референсами сработал — сравнить с разбором первой пачки
в [`prompt-stickers.md`](prompt-stickers.md), где лист снёс стиль целиком.

Три расхождения с промптом, все терпимые:

1. **Разделители пришли БЕЛЫМИ полосами ~20 px**, хотя промпт требовал
   промежутки того же серого. Ячейки из-за этого неровные — 1003–1014 px
   вместо 1024. Ровное деление вносило бы в каждую ячейку кусок чужой белой
   полосы, а она на 381 отстоит от серого при пороге вырезания в разы
   меньшем — по краю прозрачного PNG осталась бы белая кайма, видная
   на тёмной теме. Нарезка теперь ищет разделители сама (`sheet.find_gaps`),
   и ровное деление осталось запасным путём. **В следующий прогон стоит
   добавить прямой запрет:** `no white lines between the cells, the gaps are
   the same grey as the background`.
2. **Персонаж упирается в нижний край ячейки** почти везде — грудь срезана
   ровной линией. На плашке реакции это читается как погрудный портрет
   и мешает мало, но просьба «оставить поля со всех четырёх сторон» модель
   выполнила только по трём.
3. **Серые клинья внутри силуэта.** В нескольких ячейках между кепкой и щекой
   модель нарисовала вырез фона (виден в `bully_done` справа от морды).
   Это фон, он и должен был уйти в прозрачность; ошибки нарезки здесь нет.

Вырезание фона пришлось переделать дважды, и оба раза это была смена
правила, а не подбор порога.

**Заливка от краёв рабочего порога не имеет вовсе.** На 60 она выедала
собаке грудь (тень на кремовой шерсти отличается от фона на 51 из 381),
на 20 оставляла серые лоскуты у лапы и у замка. Разделяет их не яркость,
а **насыщенность**: фон нейтральный (0–6), тень на шерсти цветная
(медиана 40).

**Насыщенности и яркости тоже не хватило — на сером.** Серая кепка
`bully_unknown` нейтральна не хуже фона, а её тень (90–140) от фона (118)
неотличима по цвету в принципе. Заливка входила в кепку по шву и оставляла
прозрачные трещины; то же на ухе у `bully_fail`. В интерфейсе это
и есть «неаккуратно вырезано»: на светлой теме трещины видны белыми
чёрточками, на тёмной — чёрными, потому что сквозь них просвечивает тема.
Третий признак — **ровность**: локальный размах яркости в окне 3×3
у фона 1–2, внутри кепки медиана 10. Заливка теперь об этот перепад
останавливается и сквозь границу силуэта не проходит.

Замеры и алгоритм — в докстроке `sheet.key_background`. Сборка GIF гоняет
ту же функцию, поэтому анимация пересобиралась после каждой правки как
регрессионная проверка: девять кадров, клавиатура цела.

## Нарезка

```
python3 slice_grid.py sheet-c.jpg --cols 4 --rows 4 --names names-c.txt --out out/
```

Запасной путь, если лист пришёл плоским и его пришлось разбить надвое:

```
python3 slice_grid.py sheet-c1.png --cols 4 --rows 2 --names names-c1.txt --out out/
python3 slice_grid.py sheet-c2.png --cols 4 --rows 2 --names names-c2.txt --out out/
```

Дальше — заливка в Mattermost по одному файлу: **Main menu → Custom Emoji →
Add Custom Emoji**. Требования (128×128, PNG, до 1 МБ) и почему фон
прозрачный — в [`README.md`](README.md).

## Что проверить до нарезки

- **надпись CROSS на месте и белая во всех шестнадцати ячейках** — на
  перекрашенной кепке модель теряет её первой;
- **кепки нужного цвета ровно там, где положено.** Сверять по таблице
  выше, а не по общему впечатлению: перепутанные местами зелёная и жёлтая
  дают эмодзи, которое врёт про исход;
- **третья строка пустая** — если модель дорисовала в ячейки 9–12 галку,
  вопрос или лапы, светофор перестал отличаться от вердиктов; это
  переделка строки, нарезкой не чинится;
- **глаза того же размера, что в референсе, и рендер объёмный.** Уехавшие
  глаза и бумажная фактура — тот же слом, что на первой пачке стикеров;
- **фон ровно серый, без градиента и тени под персонажем.** Тень связана
  с фоном не везде, и вырезание оставит серые ошмётки под лапами;
- **персонаж не касается краёв ячейки** — иначе обрежется ухо;
- **клавиатуры нет ни в одной ячейке.** Второй референс — кадр анимации,
  и модель охотно тащит клавиатуру за стилем.

---

## Где это живёт в коде

Заливка эмодзи в Mattermost ничего не ломает: пока имена не подставлены
в код, новые картинки просто лежат в списке. **Подстановка — отдельная
правка**, и у неё есть порядок. Сделана 02.09 по таблице ниже; что
осталось юникодом и почему — в трёх пунктах после неё.

| эмодзи листа | что подменяет | где |
|---|---|---|
| `bully_done`, `bully_fail` | реакции дежурного `:done_checkmark:`, `:im_red_cross:` | словарь `EMOJI`, `telemetry/build_telemetry_flows.py:220` |
| `bully_high`, `bully_mid`, `bully_none`, `bully_unknown` | `CONF_DOT` — 🟢 🟡 🔴 ⚪ | `bot/build_time_flows.py:7250` |
| `bully_helpful`, `bully_not_helpful`, `bully_detail` | 👍 👎 ✍️ на кнопках и в подтверждении | `bot/build_time_flows.py:6513` (`feedback_buttons`), `telemetry/build_telemetry_flows.py:1537` |
| `bully_flag`, `bully_warn`, `bully_expert` | 🚩 ⚠️ 🧭 в служебном блоке | `bot/build_time_flows.py`, сборка служебного блока (`parts.push`) |
| `bully_ready`, `bully_work` | реакция бота на сообщение человека | `WORK_EMOJI`, `READY_EMOJI` в `bot/build_time_flows.py`; узлы `React ready in channel` / `React ready in DM` |

Три вещи, которые при этой правке ломаются молча.

**1. Словарь телеметрии привязан к именам, а не к картинкам.** Переименование
реакции в `EMOJI` без пересчёта витрины разрежет историю: старые обращения
закрыты `:done_checkmark:`, новые — `:bully_done:`, и в разрезе они окажутся
разными событиями. Правка сборщика и витрины — **одним коммитом**, оба ключа
в словаре одновременно (старый оставить, новый добавить), иначе backfill
перестанет узнавать прошлое.

**2. `🔒` в черновике трогать нельзя.** Этот замок — не украшение, а контракт
в трёх местах сразу: промпт автора требует ставить его у чувствительных полей
(`bot/prompts/export.md`), код ищет его подстрокой
(`bot/build_time_flows.py:3628`, `line.includes('🔒')`), и он попадает
в текст, который заказчик **копирует за пределы Time** — там `:bully_lock:`
останется голым текстом с двоеточиями. Поэтому `bully_lock` заменяет `🔒`
только в служебном блоке, адресованном джуну и живущем в канале. То же
рассуждение — про любой маркер внутри самого черновика: наружу уходит
юникод, наши эмодзи живут только там, где текст не покидает Time.

**3. Кнопки — не текст сообщения.** Отрисовывает ли Time кастомные эмодзи
в подписи интерактивной кнопки (`"name": "👍 Помогло"`), из исходников
видно наполовину: подпись рисует тот же `Markdown`, что и текст поста,
с `markdown: false`, и эмотиконы на этом пути обрабатываются
(`action_button.tsx` → `formatText` → `doFormatText`). Но картинку
`PostEmoji` берёт из карты эмодзи клиента и при промахе печатает голый
`:bully_helpful:`, а чем карта пополняется для подписей кнопок — не
найдено. Поэтому проба одной кнопкой на живом флоу, как и планировалось:
с 02.09 первая кнопка собрана как `:bully_helpful: Помогло`, две другие —
юникод. Видна картинка — переводим остальные и подтверждение
(`'👍 Помогло — записано, спасибо.'` в вебхуке телеметрии); виден текст
с двоеточиями — возвращаем 👍 и оставляем наши эмодзи только в тексте
постов.
